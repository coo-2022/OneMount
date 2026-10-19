package cloud115

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
)

func (f *Fs) downloadURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.Hostname() == "" {
		return nil, errors.New("cloud115: invalid download address")
	}
	if f.testServer != "" && u.Scheme+"://"+u.Host == f.testServer {
		return u, nil
	}
	host := strings.ToLower(u.Hostname())
	trusted := false
	for _, domain := range []string{"115.com", "115cdn.com", "anxia.com", "aliyuncs.com"} {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			trusted = true
		}
	}
	if u.Scheme == "http" {
		u.Scheme = "https"
	}
	if !trusted || u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") {
		return nil, errors.New("cloud115: untrusted download address")
	}
	return u, nil
}
func (o *Object) Open(ctx context.Context, options ...fs.OpenOption) (io.ReadCloser, error) {
	offset, count := int64(0), o.info.Size
	for _, option := range options {
		switch v := option.(type) {
		case *fs.RangeOption:
			offset, count = v.Decode(o.info.Size)
		case *fs.SeekOption:
			offset = v.Offset
			count = -1
		case *fs.HashesOption:
		default:
			if option.Mandatory() {
				return nil, errors.New("cloud115: unsupported mandatory read option")
			}
		}
	}
	if offset < 0 || count < -1 {
		return nil, errors.New("cloud115: invalid read range")
	}
	if offset >= o.info.Size || count == 0 {
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	if count < 0 || count > o.info.Size-offset {
		count = o.info.Size - offset
	}
	f := o.fs
	for attempt := 0; attempt < 2; attempt++ {
		var links map[string]struct {
			Size int64  `json:"file_size"`
			SHA1 string `json:"sha1"`
			URL  struct {
				URL string `json:"url"`
			} `json:"url"`
		}
		if err := f.call(ctx, "POST", "/open/ufile/downurl", url.Values{"pick_code": {o.info.PickCode}}, &links, false, true); err != nil {
			return nil, err
		}
		link, ok := links[o.info.ID]
		if !ok || link.Size != o.info.Size || (link.SHA1 != "" && !strings.EqualFold(link.SHA1, o.info.SHA1)) {
			return nil, errors.New("cloud115: download metadata changed")
		}
		u, err := f.downloadURL(link.URL.URL)
		if err != nil {
			return nil, err
		}
		var response *http.Response
		var cancel context.CancelFunc
		for hop := 0; hop <= 3; hop++ {
			requestCtx, stop := context.WithCancel(ctx)
			cancel = stop
			timer := time.AfterFunc(30*time.Second, cancel)
			req, _ := http.NewRequestWithContext(requestCtx, "GET", u.String(), nil)
			req.Header.Set("User-Agent", "CloudIsland/115")
			req.Header.Set("Accept-Encoding", "identity")
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+count-1))
			response, err = f.client.Do(req)
			timer.Stop()
			if err != nil {
				cancel()
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, errors.New("cloud115: download network request failed")
			}
			if response.StatusCode >= 300 && response.StatusCode < 400 {
				location := response.Header.Get("Location")
				response.Body.Close()
				cancel()
				next, e := url.Parse(location)
				if e != nil || location == "" || hop == 3 {
					return nil, errors.New("cloud115: invalid download redirect")
				}
				u, err = f.downloadURL(u.ResolveReference(next).String())
				if err != nil {
					return nil, err
				}
				continue
			}
			break
		}
		if response.StatusCode == 403 && attempt == 0 {
			response.Body.Close()
			cancel()
			continue
		}
		expected := fmt.Sprintf("bytes %d-%d/%d", offset, offset+count-1, o.info.Size)
		if (response.StatusCode == 206 && response.Header.Get("Content-Range") != expected) || (response.StatusCode != 206 && (response.StatusCode != 200 || offset != 0 || count != o.info.Size)) || (response.ContentLength >= 0 && response.ContentLength != count) {
			response.Body.Close()
			cancel()
			return nil, errors.New("cloud115: download range or length mismatch")
		}
		return &downloadReader{body: response.Body, remaining: count, cancel: cancel}, nil
	}
	return nil, errors.New("cloud115: download link expired")
}

type downloadReader struct {
	body      io.ReadCloser
	remaining int64
	cancel    context.CancelFunc
	done      bool
}

func (r *downloadReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	timer := time.AfterFunc(30*time.Second, r.cancel)
	defer timer.Stop()
	if r.remaining == 0 {
		var extra [1]byte
		n, err := r.body.Read(extra[:])
		if n != 0 {
			return 0, errors.New("cloud115: download exceeded requested range")
		}
		if err == io.EOF {
			r.done = true
			return 0, io.EOF
		}
		if err != nil {
			return 0, errors.New("cloud115: download interrupted")
		}
		return 0, nil
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.body.Read(p)
	r.remaining -= int64(n)
	if err == io.EOF {
		if r.remaining != 0 {
			return n, io.ErrUnexpectedEOF
		}
		r.done = true
		return n, io.EOF
	}
	if err != nil {
		return n, errors.New("cloud115: download interrupted")
	}
	return n, nil
}
func (r *downloadReader) Close() error { r.cancel(); return r.body.Close() }
