package cloud115

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
	"github.com/rclone/rclone/fs"
)

type uploadInfo struct {
	Status    int    `json:"status"`
	SignKey   string `json:"sign_key"`
	SignCheck string `json:"sign_check"`
	Bucket    string `json:"bucket"`
	Object    string `json:"object"`
	Callback  struct {
		Callback  string `json:"callback"`
		Variables string `json:"callback_var"`
	} `json:"callback"`
}

func (u *uploadInfo) UnmarshalJSON(b []byte) error {
	// Rapid-upload responses may return callback:[], instead of an object.
	var raw struct {
		Status    int             `json:"status"`
		SignKey   string          `json:"sign_key"`
		SignCheck string          `json:"sign_check"`
		Bucket    string          `json:"bucket"`
		Object    string          `json:"object"`
		Callback  json.RawMessage `json:"callback"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*u = uploadInfo{Status: raw.Status, SignKey: raw.SignKey, SignCheck: raw.SignCheck, Bucket: raw.Bucket, Object: raw.Object}
	if len(raw.Callback) > 0 && string(raw.Callback) != "[]" && string(raw.Callback) != "null" {
		return json.Unmarshal(raw.Callback, &u.Callback)
	}
	return nil
}

type uploadToken struct {
	Endpoint string `json:"endpoint"`
	Key      string `json:"AccessKeyId"`
	Secret   string `json:"AccessKeySecret"`
	Security string `json:"SecurityToken"`
}

func (f *Fs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	o := &Object{fs: f, remote: src.Remote()}
	if err := o.Update(ctx, in, src, options...); err != nil {
		return nil, err
	}
	return o, nil
}
func temporaryName() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return ".cloud-island-upload-" + fmt.Sprintf("%x", b)
}
func (o *Object) Update(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) error {
	if err := validPath(o.remote); err != nil {
		return err
	}
	if o.remote == "" || src.Size() < 0 {
		return errors.New("cloud115: upload requires a named file and known size")
	}
	for _, opt := range options {
		if _, ok := opt.(*fs.HashesOption); !ok && opt.Mandatory() {
			return errors.New("cloud115: unsupported mandatory upload option")
		}
	}
	tmp, err := os.CreateTemp("", "cloud-island-115-upload-*")
	if err != nil {
		return errors.New("cloud115: cannot create upload snapshot")
	}
	defer func() { tmp.Close(); os.Remove(tmp.Name()) }()
	fullHash := sha1.New()
	buf := make([]byte, 256*1024)
	remaining := src.Size()
	for remaining > 0 {
		if err = ctx.Err(); err != nil {
			return err
		}
		n := min(int64(len(buf)), remaining)
		if _, err = io.ReadFull(in, buf[:n]); err != nil {
			return errors.New("cloud115: upload source ended early")
		}
		if _, err = tmp.Write(buf[:n]); err != nil {
			return errors.New("cloud115: upload snapshot write failed")
		}
		fullHash.Write(buf[:n])
		remaining -= n
	}
	var extra [1]byte
	if n, e := in.Read(extra[:]); n != 0 || e != io.EOF {
		return errors.New("cloud115: upload source size mismatch")
	}
	digest := fmt.Sprintf("%X", fullHash.Sum(nil))
	pre := sha1.New()
	if _, err = io.Copy(pre, io.NewSectionReader(tmp, 0, min(src.Size(), 128*1024))); err != nil {
		return errors.New("cloud115: cannot read upload snapshot")
	}
	f := o.fs
	f.mutations.Lock()
	defer f.mutations.Unlock()
	leaf, parent, err := f.dirs.FindPath(ctx, o.remote, true)
	if err != nil {
		return err
	}
	old, lookupErr := f.lookup(ctx, parent, leaf)
	if lookupErr == nil && old.isDir() {
		return fs.ErrorIsDir
	}
	if lookupErr != nil && !errors.Is(lookupErr, fs.ErrorObjectNotFound) {
		return lookupErr
	}
	stagedName := temporaryName()
	values := url.Values{"file_name": {stagedName}, "file_size": {fmt.Sprint(src.Size())}, "target": {"U_1_" + parent}, "fileid": {digest}, "preid": {fmt.Sprintf("%X", pre.Sum(nil))}}
	var init uploadInfo
	if err = f.call(ctx, "POST", "/open/upload/init", values, &init, false, false); err != nil {
		return err
	}
	if init.Status == 6 || init.Status == 7 || init.Status == 8 {
		parts := strings.Split(init.SignCheck, "-")
		if len(parts) != 2 {
			return errors.New("cloud115: invalid upload challenge")
		}
		start, e1 := strconv.ParseInt(parts[0], 10, 64)
		end, e2 := strconv.ParseInt(parts[1], 10, 64)
		if e1 != nil || e2 != nil || start < 0 || end < start || end >= src.Size() || init.SignKey == "" {
			return errors.New("cloud115: invalid upload challenge")
		}
		h := sha1.New()
		if _, err = io.Copy(h, io.NewSectionReader(tmp, start, end-start+1)); err != nil {
			return errors.New("cloud115: cannot read upload challenge")
		}
		values.Set("sign_key", init.SignKey)
		values.Set("sign_val", fmt.Sprintf("%X", h.Sum(nil)))
		if err = f.call(ctx, "POST", "/open/upload/init", values, &init, false, false); err != nil {
			return err
		}
	}
	if init.Status != 2 {
		if init.Status != 1 {
			return fmt.Errorf("cloud115: upload initialization rejected status=%d", init.Status)
		}
		var token uploadToken
		if err = f.call(ctx, "GET", "/open/upload/get_token", nil, &token, false, true); err != nil {
			return err
		}
		if err = f.uploadOSS(ctx, tmp, src.Size(), init, token); err != nil {
			return err
		}
	}
	// The OSS callback alone is insufficient: verify the visible object before
	// publishing it or touching any old destination. Never delete the old file first.
	var staged entry
	for attempt := 0; attempt < 15; attempt++ {
		staged, err = f.lookup(ctx, parent, stagedName)
		if err == nil && staged.Size == src.Size() && strings.EqualFold(staged.SHA1, digest) && (staged.UploadState == "" || staged.UploadState == "1") {
			break
		}
		if err != nil && !errors.Is(err, fs.ErrorObjectNotFound) {
			return err
		}
		if err = pause(ctx, 2*time.Second); err != nil {
			return err
		}
	}
	if staged.ID == "" || staged.Size != src.Size() || !strings.EqualFold(staged.SHA1, digest) || (staged.UploadState != "" && staged.UploadState != "1") {
		return errors.New("cloud115: uploaded object not confirmed; old destination preserved")
	}
	current, currentErr := f.lookup(ctx, parent, leaf)
	if (lookupErr == nil && (currentErr != nil || current.ID != old.ID || current.Size != old.Size || current.SHA1 != old.SHA1)) || (lookupErr != nil && !errors.Is(currentErr, fs.ErrorObjectNotFound)) {
		return errors.New("cloud115: destination changed during upload; staged file preserved")
	}
	backup := ""
	if lookupErr == nil {
		backup = temporaryName() + "-previous"
		if err = f.rename(ctx, old.ID, backup); err != nil {
			return err
		}
	}
	if err = f.rename(ctx, staged.ID, leaf); err != nil {
		// A lost response may mean the rename actually committed. Preserve both
		// versions and report failure when the server outcome cannot be established.
		if backup != "" {
			recoverCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
			if _, e := f.lookup(recoverCtx, parent, leaf); errors.Is(e, fs.ErrorObjectNotFound) {
				_ = f.rename(recoverCtx, old.ID, leaf)
			}
			cancel()
		}
		return errors.New("cloud115: publishing upload failed; previous data preserved")
	}
	if backup != "" {
		if err = f.removeID(ctx, old.ID, parent); err != nil {
			return errors.New("cloud115: new file published but previous version cleanup failed")
		}
	}
	staged.Name = f.opt.Enc.FromStandardName(leaf)
	staged.Parent = parent
	o.info = staged
	return nil
}

var bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)

func (f *Fs) uploadOSS(ctx context.Context, file *os.File, size int64, u uploadInfo, t uploadToken) error {
	endpoint, err := url.Parse(t.Endpoint)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Path != "" && endpoint.Path != "/") {
		return errors.New("cloud115: invalid upload endpoint")
	}
	if f.testServer == "" || endpoint.Scheme+"://"+endpoint.Host != f.testServer {
		if endpoint.Scheme == "http" {
			endpoint.Scheme = "https"
		}
		if endpoint.Scheme != "https" || !strings.HasSuffix(endpoint.Hostname(), ".aliyuncs.com") || (endpoint.Port() != "" && endpoint.Port() != "443") {
			return errors.New("cloud115: untrusted upload endpoint")
		}
	}
	if !bucketPattern.MatchString(u.Bucket) || u.Object == "" || t.Key == "" || t.Secret == "" || t.Security == "" || u.Callback.Callback == "" {
		return errors.New("cloud115: incomplete upload credentials")
	}
	options := []oss.ClientOption{oss.SecurityToken(t.Security), oss.HTTPClient(f.client), oss.Timeout(30, 120)}
	if f.testServer != "" {
		options = append(options, oss.UseCname(true))
	}
	client, err := oss.New(endpoint.String(), t.Key, t.Secret, options...)
	if err != nil {
		return errors.New("cloud115: upload initialization failed")
	}
	bucket, err := client.Bucket(u.Bucket)
	if err != nil {
		return errors.New("cloud115: invalid upload bucket")
	}
	callback := []oss.Option{oss.WithContext(ctx), oss.Callback(base64.StdEncoding.EncodeToString([]byte(u.Callback.Callback))), oss.CallbackVar(base64.StdEncoding.EncodeToString([]byte(u.Callback.Variables)))}
	if size == 0 {
		if err = bucket.PutObject(u.Object, io.NewSectionReader(file, 0, 0), callback...); err != nil {
			return errors.New("cloud115: empty-file upload rejected")
		}
		return nil
	}
	upload, err := bucket.InitiateMultipartUpload(u.Object, oss.WithContext(ctx))
	if err != nil {
		return errors.New("cloud115: multipart initialization failed")
	}
	completed := false
	defer func() {
		if !completed {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
			defer cancel()
			_ = bucket.AbortMultipartUpload(upload, oss.WithContext(cleanup))
		}
	}()
	partSize := max(int64(8*1024*1024), (size+9998)/9999)
	var parts []oss.UploadPart
	for offset, number := int64(0), 1; offset < size; number++ {
		length := min(partSize, size-offset)
		var part oss.UploadPart
		for attempt := 0; attempt < 3; attempt++ {
			if err = ctx.Err(); err != nil {
				return err
			}
			part, err = bucket.UploadPart(upload, io.NewSectionReader(file, offset, length), length, number, oss.WithContext(ctx))
			if err == nil {
				break
			}
			if e := pause(ctx, time.Duration(attempt+1)*time.Second); e != nil {
				return e
			}
		}
		if err != nil {
			return errors.New("cloud115: upload part failed")
		}
		parts = append(parts, part)
		offset += length
	}
	var callbackBody []byte
	callback = append(callback, oss.CallbackResult(&callbackBody))
	if _, err = bucket.CompleteMultipartUpload(upload, parts, callback...); err != nil {
		return errors.New("cloud115: upload completion failed")
	}
	completed = true
	return nil
}
