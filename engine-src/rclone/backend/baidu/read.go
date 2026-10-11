package baidu

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

// Never send a token to a host returned in an unvalidated response. Redirects
// are checked individually and do not inherit a bearer Authorization header.
func (f *Fs) transferURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.Hostname() == "" {
		return nil, errors.New("baidu: invalid transfer address")
	}
	if f.testServer != "" && u.Scheme+"://"+u.Host == f.testServer {
		return u, nil
	}
	h := strings.ToLower(u.Hostname())
	if u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") || !(strings.HasSuffix(h, ".baidu.com") || strings.HasSuffix(h, ".baidupcs.com")) {
		return nil, errors.New("baidu: untrusted transfer address")
	}
	return u, nil
}
func sameVersion(a, b entry) bool {
	return a.ID == b.ID && samePath(a.Path, b.Path) && a.Size == b.Size && a.IsDir == b.IsDir && a.MD5 == b.MD5 && a.Mtime == b.Mtime
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
				return nil, errors.New("baidu: unsupported mandatory read option")
			}
		}
	}
	if offset < 0 || count < -1 {
		return nil, errors.New("baidu: invalid read range")
	}
	if offset >= o.info.Size || count == 0 {
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	if count < 0 || count > o.info.Size-offset {
		count = o.info.Size - offset
	}
	for attempt := 0; attempt < 2; attempt++ {
		before, err := o.fs.metadata(ctx, o.info.ID, true)
		if err != nil {
			return nil, err
		}
		if !sameVersion(o.info, before) {
			return nil, errors.New("baidu: file changed before read")
		}
		u, err := o.fs.transferURL(before.Dlink)
		if err != nil {
			return nil, err
		}
		token, err := o.fs.tokens.Token()
		if err != nil {
			return nil, errors.New("baidu: authorization refresh failed")
		}
		q := u.Query()
		q.Set("access_token", token.AccessToken)
		u.RawQuery = q.Encode()
		var resp *http.Response
		var cancel context.CancelFunc
		for hop := 0; hop <= 3; hop++ {
			if _, err = o.fs.transferURL(u.String()); err != nil {
				return nil, err
			}
			var requestCtx context.Context
			requestCtx, cancel = context.WithCancel(ctx)
			// Bound header waits without a total transfer deadline on throttled accounts.
			timer := time.AfterFunc(30*time.Second, cancel)
			req, _ := http.NewRequestWithContext(requestCtx, "GET", u.String(), nil)
			req.Header.Set("User-Agent", "pan.baidu.com")
			req.Header.Set("Accept-Encoding", "identity")
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+count-1))
			resp, err = o.fs.client.Do(req)
			timer.Stop()
			if err != nil {
				cancel()
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, errors.New("baidu: download network request failed")
			}
			if resp.StatusCode >= 300 && resp.StatusCode < 400 {
				location := resp.Header.Get("Location")
				resp.Body.Close()
				cancel()
				if location == "" || hop == 3 {
					return nil, errors.New("baidu: invalid download redirect")
				}
				next, parseErr := url.Parse(location)
				if parseErr != nil {
					return nil, errors.New("baidu: invalid download redirect")
				}
				u = u.ResolveReference(next)
				continue
			}
			break
		}
		if (resp.StatusCode == 401 || resp.StatusCode == 403) && attempt == 0 {
			resp.Body.Close()
			cancel()
			if resp.StatusCode == 401 {
				_ = o.fs.tokens.Expire()
			}
			continue
		}
		if resp.StatusCode == http.StatusPartialContent {
			expected := fmt.Sprintf("bytes %d-%d/%d", offset, offset+count-1, before.Size)
			if resp.Header.Get("Content-Range") != expected {
				resp.Body.Close()
				cancel()
				return nil, errors.New("baidu: invalid Content-Range")
			}
		} else if resp.StatusCode != 200 || offset != 0 || count != before.Size {
			resp.Body.Close()
			cancel()
			return nil, fmt.Errorf("baidu: range download rejected (HTTP %d)", resp.StatusCode)
		}
		if resp.ContentLength >= 0 && resp.ContentLength != count {
			resp.Body.Close()
			cancel()
			return nil, errors.New("baidu: unexpected download length")
		}
		return &checkedRead{body: resp.Body, remaining: count, cancel: cancel, verify: func() error {
			after, e := o.fs.metadata(ctx, before.ID, false)
			if e != nil {
				return e
			}
			if !sameVersion(before, after) {
				return errors.New("baidu: file changed during read")
			}
			return nil
		}}, nil
	}
	return nil, errors.New("baidu: download authorization failed")
}

type checkedRead struct {
	body      io.ReadCloser
	remaining int64
	cancel    context.CancelFunc
	verify    func() error
	done      bool
}

func (r *checkedRead) Read(p []byte) (int, error) {
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
		n, e := r.body.Read(extra[:])
		if n != 0 {
			return 0, errors.New("baidu: download exceeded requested range")
		}
		if e != io.EOF {
			if e != nil {
				return 0, errors.New("baidu: download interrupted")
			}
			return 0, nil
		}
		r.done = true
		if e = r.verify(); e != nil {
			return 0, e
		}
		return 0, io.EOF
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, e := r.body.Read(p)
	r.remaining -= int64(n)
	if e == io.EOF {
		if r.remaining != 0 {
			return n, io.ErrUnexpectedEOF
		}
		r.done = true
		if err := r.verify(); err != nil {
			return n, err
		}
		return n, io.EOF
	}
	if e != nil {
		return n, errors.New("baidu: download interrupted")
	}
	return n, nil
}
func (r *checkedRead) Close() error { r.cancel(); return r.body.Close() }
