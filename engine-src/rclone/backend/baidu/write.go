package baidu

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/rclone/rclone/fs"
)

const sliceSize = 4 * 1024 * 1024

func (f *Fs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	o := &Object{fs: f, remote: src.Remote()}
	if err := o.Update(ctx, in, src, options...); err != nil {
		return nil, err
	}
	return o, nil
}
func (o *Object) Update(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) error {
	if err := validRelative(o.remote); err != nil {
		return err
	}
	if o.remote == "" || src.Size() < 0 {
		return errors.New("baidu: upload needs a named file and known size")
	}
	// The live Open Platform rejects zero-byte file creation (errno 10).
	// Never acknowledge a local placeholder as a remotely stored file.
	if src.Size() == 0 {
		return fs.ErrorCantUploadEmptyFiles
	}
	for _, opt := range options {
		if _, ok := opt.(*fs.HashesOption); !ok && opt.Mandatory() {
			return errors.New("baidu: unsupported mandatory upload option")
		}
	}
	// Precreate needs every slice checksum before it accepts content. Keep one
	// immutable local snapshot; bound memory to a slice rather than file size.
	tmp, err := os.CreateTemp("", "cloud-island-baidu-upload-*")
	if err != nil {
		return errors.New("baidu: cannot create upload snapshot")
	}
	defer func() { tmp.Close(); os.Remove(tmp.Name()) }()
	digests := []string{}
	buf := make([]byte, sliceSize)
	remaining := src.Size()
	for remaining > 0 {
		if err = ctx.Err(); err != nil {
			return err
		}
		n := min(int64(sliceSize), remaining)
		if _, err = io.ReadFull(in, buf[:n]); err != nil {
			return errors.New("baidu: upload source ended early")
		}
		if _, err = tmp.Write(buf[:n]); err != nil {
			return errors.New("baidu: upload snapshot write failed")
		}
		digests = append(digests, fmt.Sprintf("%x", md5.Sum(buf[:n])))
		remaining -= n
	}
	// Do not silently truncate a reader which disagrees with its declared size.
	var extra [1]byte
	if n, e := in.Read(extra[:]); n != 0 || e != io.EOF {
		return errors.New("baidu: upload source size mismatch")
	}
	if err = tmp.Sync(); err != nil {
		return errors.New("baidu: upload snapshot flush failed")
	}
	parent := path.Dir(o.remote)
	if parent == "." {
		parent = ""
	}
	if err = o.fs.Mkdir(ctx, parent); err != nil {
		return err
	}
	target := o.fs.fullPath(o.remote)
	// Use the server's spelling for an existing object. Do not lowercase names
	// or create a second object because only its parent's spelling differs.
	existing, lookupErr := o.fs.statPath(ctx, target)
	if lookupErr == nil {
		if existing.IsDir != 0 {
			return fs.ErrorIsDir
		}
		target = existing.Path
	} else if !errors.Is(lookupErr, fs.ErrorObjectNotFound) {
		return lookupErr
	}
	mtime := strconv.FormatInt(src.ModTime(ctx).Unix(), 10)
	blocks, _ := json.Marshal(digests)
	{
		var pre struct {
			UploadID   string `json:"uploadid"`
			ReturnType int    `json:"return_type"`
			BlockList  []int  `json:"block_list"`
		}
		err = o.fs.post(ctx, fileAPI, values("method", "precreate"), values("path", target, "size", strconv.FormatInt(src.Size(), 10), "isdir", "0", "autoinit", "1", "rtype", "3", "block_list", string(blocks), "local_mtime", mtime), &pre)
		if err != nil {
			return err
		}
		if pre.ReturnType != 1 && pre.ReturnType != 2 {
			return errors.New("baidu: unknown precreate result")
		}
		if pre.ReturnType != 2 {
			if pre.UploadID == "" {
				return errors.New("baidu: upload session missing")
			}
			host, err := o.fs.locateUpload(ctx, target, pre.UploadID)
			if err != nil {
				return err
			}
			parts := pre.BlockList
			if parts == nil {
				parts = make([]int, len(digests))
				for i := range parts {
					parts[i] = i
				}
			}
			seen := map[int]bool{}
			for _, part := range parts {
				if part < 0 || part >= len(digests) || seen[part] {
					return errors.New("baidu: invalid upload slice list")
				}
				seen[part] = true
				if err = ctx.Err(); err != nil {
					return err
				}
				offset := int64(part) * sliceSize
				n := min(int64(sliceSize), src.Size()-offset)
				if _, err = tmp.ReadAt(buf[:n], offset); err != nil {
					return errors.New("baidu: upload snapshot read failed")
				}
				var data bytes.Buffer
				mw := multipart.NewWriter(&data)
				file, _ := mw.CreateFormFile("file", "blob")
				if _, err = file.Write(buf[:n]); err != nil {
					return err
				}
				if err = mw.Close(); err != nil {
					return err
				}
				var result struct {
					MD5 string `json:"md5"`
				}
				err = o.fs.call(ctx, host, "/rest/2.0/pcs/superfile2", values("method", "upload", "type", "tmpfile", "path", target, "uploadid", pre.UploadID, "partseq", strconv.Itoa(part)), data.Bytes(), mw.FormDataContentType(), true, &result)
				if err != nil {
					return err
				}
				if !strings.EqualFold(result.MD5, digests[part]) {
					return errors.New("baidu: uploaded slice checksum mismatch")
				}
			}
		}
		// Some precreate responses finish rapid uploads without an uploadid. Only
		// the verified final path/size below can acknowledge that outcome.
		if pre.UploadID != "" {
			var result entry
			err = o.fs.post(ctx, fileAPI, values("method", "create"), values("path", target, "size", strconv.FormatInt(src.Size(), 10), "isdir", "0", "rtype", "3", "uploadid", pre.UploadID, "block_list", string(blocks), "local_mtime", mtime), &result)
			if err != nil {
				return err
			}
			if result.ID <= 0 || !sameDestination(result.Path, target) || result.Size != src.Size() || result.IsDir != 0 {
				return errors.New("baidu: file commit not confirmed")
			}
		}
	}
	result, err := o.fs.statPath(ctx, target)
	if err != nil {
		return err
	}
	if result.Size != src.Size() || result.IsDir != 0 {
		return errors.New("baidu: uploaded file is not yet readable")
	}
	o.info = result
	return nil
}
func (f *Fs) locateUpload(ctx context.Context, p, id string) (string, error) {
	var result struct {
		Servers []struct {
			Server string `json:"server"`
		} `json:"servers"`
	}
	// This is the same public locateupload endpoint and appid used by the
	// previously verified Rust adapter; it returns per-upload storage hosts.
	err := f.call(ctx, f.pcs, "/rest/2.0/pcs/file", values("method", "locateupload", "appid", "250528", "path", p, "uploadid", id, "upload_version", "2.0"), nil, "", true, &result)
	if err != nil {
		return "", err
	}
	if len(result.Servers) == 0 {
		return "", errors.New("baidu: upload host missing")
	}
	u, err := f.transferURL(result.Servers[0].Server)
	if err != nil {
		return "", err
	}
	if f.testServer == "" && !(strings.HasSuffix(u.Hostname(), ".pcs.baidu.com") || strings.HasSuffix(u.Hostname(), ".baidupcs.com")) {
		return "", errors.New("baidu: untrusted upload host")
	}
	return u.Scheme + "://" + u.Host, nil
}
