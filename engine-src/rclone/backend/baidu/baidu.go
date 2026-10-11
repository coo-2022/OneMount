// Package baidu implements the personal Baidu Netdisk Open Platform API.
// Protocol behavior is ported from OpenEarth-Data's Rust baidu adapter; rclone
// owns filesystem caching, writeback, credential persistence and mount lifetime.
package baidu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/fshttp"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/lib/encoder"
	"github.com/rclone/rclone/lib/oauthutil"
	"github.com/rclone/rclone/lib/pacer"
	"golang.org/x/oauth2"
)

const fileAPI = "/rest/2.0/xpan/file"
const metaAPI = "/rest/2.0/xpan/multimedia"
const pageSize = 1000

var oauthConfig = &oauthutil.Config{
	AuthURL: "https://openapi.baidu.com/oauth/2.0/authorize", TokenURL: "https://openapi.baidu.com/oauth/2.0/token",
	Scopes: []string{"basic", "netdisk"}, AuthStyle: oauth2.AuthStyleInParams,
}

func init() {
	fs.Register(&fs.RegInfo{Name: "baidu", Description: "Baidu Netdisk (Open Platform)", NewFs: NewFs,
		Options: append(oauthutil.SharedOptions, fs.Option{Name: config.ConfigEncoding, Help: config.ConfigEncodingHelp, Advanced: true,
			Default: encoder.Display | encoder.EncodeBackSlash | encoder.EncodeCtl | encoder.EncodeDel | encoder.EncodeInvalidUtf8 | encoder.EncodeRightSpace})})
}

type options struct {
	Enc encoder.MultiEncoder `config:"encoding"`
}
type tokenSource interface {
	Token() (*oauth2.Token, error)
	Expire() error
}
type Fs struct {
	name, root string
	opt        options
	features   *fs.Features
	client     *http.Client
	tokens     tokenSource
	pacer      *fs.Pacer
	api, pcs   string
	// Only tests set this; production endpoints and transfer hosts cannot be configured.
	testServer string
}
type entry struct {
	ID           int64  `json:"fs_id"`
	Path         string `json:"path"`
	Size         int64  `json:"size"`
	IsDir        int    `json:"isdir"`
	Mtime        int64  `json:"server_mtime"`
	LocalMtime   int64  `json:"local_mtime"`
	CreatedMtime int64  `json:"mtime"`
	Dlink        string `json:"dlink"`
	MD5          string `json:"md5"`
}

func (e entry) modTime() time.Time {
	t := e.LocalMtime
	if t == 0 {
		t = e.Mtime
	}
	if t == 0 {
		t = e.CreatedMtime
	}
	return time.Unix(t, 0)
}

type Object struct {
	fs     *Fs
	remote string
	info   entry
}

func NewFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	f := &Fs{name: name, root: strings.Trim(root, "/"), api: "https://pan.baidu.com", pcs: "https://d.pcs.baidu.com"}
	if err := validRelative(f.root); err != nil {
		return nil, err
	}
	if err := configstruct.Set(m, &f.opt); err != nil {
		return nil, err
	}
	client := fshttp.NewClient(ctx)
	// API requests carry access_token in the query. Never attach Bearer headers
	// to CDN redirects; refreshed tokens are saved by rclone's config mapper.
	_, ts, err := oauthutil.NewClientWithBaseClient(ctx, name, m, oauthConfig, client)
	if err != nil {
		return nil, errors.New("baidu: login required")
	}
	f.tokens = ts
	f.client = client
	f.client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	f.pacer = fs.NewPacer(ctx, pacer.NewDefault(pacer.MinSleep(100*time.Millisecond), pacer.MaxSleep(5*time.Second), pacer.DecayConstant(2)))
	f.features = (&fs.Features{CanHaveEmptyDirectories: true}).Fill(ctx, f)
	if f.root != "" {
		e, err := f.statPath(ctx, f.fullPath(""))
		if errors.Is(err, fs.ErrorObjectNotFound) || errors.Is(err, fs.ErrorDirNotFound) {
			return f, nil
		}
		if err != nil {
			return nil, err
		}
		if e.IsDir == 0 {
			f.root = path.Dir(f.root)
			if f.root == "." {
				f.root = ""
			}
			return f, fs.ErrorIsFile
		}
	}
	return f, nil
}
func (f *Fs) Name() string             { return f.name }
func (f *Fs) Root() string             { return f.root }
func (f *Fs) String() string           { return "Baidu Netdisk root " + f.root }
func (f *Fs) Precision() time.Duration { return time.Second }

// Baidu's md5 is useful as a change marker but isn't consistently a plaintext
// whole-file checksum, so do not advertise it to rclone's integrity checker.
func (f *Fs) Hashes() hash.Set       { return hash.NewHashSet(hash.None) }
func (f *Fs) Features() *fs.Features { return f.features }
func validRelative(s string) error {
	if strings.HasPrefix(s, "/") || strings.ContainsRune(s, 0) {
		return errors.New("baidu: invalid path")
	}
	for _, part := range strings.Split(s, "/") {
		if part == "." || part == ".." {
			return errors.New("baidu: invalid path")
		}
	}
	return nil
}
func (f *Fs) fullPath(remote string) string {
	return f.opt.Enc.FromStandardPath(path.Join("/", f.root, remote))
}
func values(kv ...string) url.Values {
	q := url.Values{}
	for i := 0; i < len(kv); i += 2 {
		q.Set(kv[i], kv[i+1])
	}
	return q
}
func codeError(code int) error {
	switch code {
	case 0:
		return nil
	case -7, -9, 12, 31064:
		return fs.ErrorObjectNotFound
	case -8, 31061:
		return fs.ErrorDirExists
	case -6, 110, 111, 20016, 20017, 31045:
		return errors.New("baidu: authorization expired")
	case -10, 31190:
		return errors.New("baidu: storage full")
	default:
		return fmt.Errorf("baidu: errno %d", code)
	}
}
func authCode(code int) bool {
	return code == -6 || code == 110 || code == 111 || code == 20016 || code == 20017 || code == 31045
}

// call only returns numeric server diagnostics, never raw bodies or URLs which
// can contain credentials. Mutations are not blindly replayed on network errors.
func (f *Fs) call(ctx context.Context, base, endpoint string, q url.Values, body []byte, contentType string, retry bool, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	refreshed := false
	return f.pacer.Call(func() (bool, error) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		token, err := f.tokens.Token()
		if err != nil {
			return false, errors.New("baidu: authorization refresh failed")
		}
		u, err := url.Parse(base + endpoint)
		if err != nil {
			return false, errors.New("baidu: invalid endpoint")
		}
		query := url.Values{}
		for k, v := range q {
			query[k] = append([]string(nil), v...)
		}
		query.Set("access_token", token.AccessToken)
		u.RawQuery = query.Encode()
		method := "GET"
		if body != nil {
			method = "POST"
		}
		req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
		if err != nil {
			return false, errors.New("baidu: invalid request")
		}
		req.Header.Set("User-Agent", "pan.baidu.com")
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := f.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			return retry, errors.New("baidu: network request failed")
		}
		defer resp.Body.Close()
		if resp.StatusCode == 401 && !refreshed {
			refreshed = true
			if f.tokens.Expire() != nil {
				return false, errors.New("baidu: authorization refresh failed")
			}
			return true, errors.New("baidu: refreshing authorization")
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return retry && (resp.StatusCode == 429 || resp.StatusCode >= 500), fmt.Errorf("baidu: HTTP %d", resp.StatusCode)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
		if err != nil || len(raw) > 4*1024*1024 {
			return retry, errors.New("baidu: invalid API response")
		}
		var envelope struct {
			Errno     *int `json:"errno"`
			ErrorCode *int `json:"error_code"`
		}
		if json.Unmarshal(raw, &envelope) != nil {
			return false, errors.New("baidu: invalid API response")
		}
		code := 0
		if envelope.Errno != nil {
			code = *envelope.Errno
		}
		if envelope.ErrorCode != nil {
			code = *envelope.ErrorCode
		}
		if authCode(code) && !refreshed {
			refreshed = true
			if f.tokens.Expire() != nil {
				return false, errors.New("baidu: authorization refresh failed")
			}
			return true, errors.New("baidu: refreshing authorization")
		}
		if code != 0 {
			return retry && (code == 31034 || code == 31066 || code == 31326), codeError(code)
		}
		if err = json.Unmarshal(raw, out); err != nil {
			return false, errors.New("baidu: malformed API result")
		}
		return false, nil
	})
}
func (f *Fs) get(ctx context.Context, endpoint string, q url.Values, out any) error {
	return f.call(ctx, f.api, endpoint, q, nil, "", true, out)
}
func (f *Fs) post(ctx context.Context, endpoint string, q, form url.Values, out any) error {
	return f.call(ctx, f.api, endpoint, q, []byte(form.Encode()), "application/x-www-form-urlencoded", false, out)
}

// Baidu can return historical directory spellings (Camera/camera) within one
// listing. Compare those spellings locally, without changing displayed names,
// request paths or the global CaseInsensitive filesystem capability.
func validAbsolutePath(p string) bool {
	return strings.HasPrefix(p, "/") && path.Clean(p) == p
}

func samePath(a, b string) bool {
	return validAbsolutePath(a) && validAbsolutePath(b) && strings.EqualFold(a, b)
}

// A successful create must retain the requested leaf name. Only its parent may
// use a different spelling; a rename must not silently change the destination.
func sameDestination(a, b string) bool {
	return validAbsolutePath(a) && validAbsolutePath(b) && path.Base(a) == path.Base(b) && samePath(path.Dir(a), path.Dir(b))
}

func (f *Fs) listPath(ctx context.Context, dir string) ([]entry, error) {
	if !validAbsolutePath(dir) {
		return nil, errors.New("baidu: invalid directory path")
	}
	result := []entry{}
	seen := map[int64]bool{}
	names := map[string]bool{}
	for start := 0; ; start += pageSize {
		var page struct {
			List []entry `json:"list"`
		}
		err := f.get(ctx, fileAPI, values("method", "list", "dir", dir, "order", "name", "start", strconv.Itoa(start), "limit", strconv.Itoa(pageSize)), &page)
		if errors.Is(err, fs.ErrorObjectNotFound) {
			return nil, fs.ErrorDirNotFound
		}
		if err != nil {
			return nil, err
		}
		if page.List == nil {
			return nil, errors.New("baidu: missing directory listing")
		}
		for index, e := range page.List {
			// Only structural diagnostics: never log provider bodies or credentials.
			reason := ""
			switch {
			case e.ID <= 0:
				reason = "invalid entry ID"
			case e.Size < 0:
				reason = "negative entry size"
			case !validAbsolutePath(e.Path) || e.Path == "/":
				reason = "invalid entry path"
			case !samePath(path.Dir(e.Path), dir):
				reason = "entry parent mismatch"
			case seen[e.ID]:
				reason = "repeated entry ID"
			case names[path.Base(e.Path)]:
				reason = "repeated entry name"
			}
			if reason != "" {
				return nil, fmt.Errorf("baidu: directory listing %s (start=%d index=%d)", reason, start, index)
			}
			seen[e.ID] = true
			names[path.Base(e.Path)] = true
			result = append(result, e)
		}
		if len(page.List) < pageSize {
			return result, nil
		}
	}
}
func (f *Fs) statPath(ctx context.Context, p string) (entry, error) {
	if !validAbsolutePath(p) {
		return entry{}, errors.New("baidu: invalid lookup path")
	}
	if p == "/" {
		return entry{Path: "/", IsDir: 1}, nil
	}
	entries, err := f.listPath(ctx, path.Dir(p))
	if err != nil {
		return entry{}, err
	}
	// Prefer an exact path, then an exact leaf under a parent alias. Use a
	// folded leaf only when unique, so case-distinct files are never conflated.
	best, matches := 0, 0
	var found entry
	for _, e := range entries {
		score := 0
		switch {
		case e.Path == p:
			score = 3
		case sameDestination(e.Path, p):
			score = 2
		case samePath(e.Path, p):
			score = 1
		}
		if score > best {
			best, matches, found = score, 1, e
		} else if score != 0 && score == best {
			matches++
		}
	}
	if matches > 1 {
		return entry{}, errors.New("baidu: ambiguous case-insensitive path lookup")
	}
	if matches == 1 {
		return found, nil
	}
	return entry{}, fs.ErrorObjectNotFound
}
func (f *Fs) List(ctx context.Context, dir string) (fs.DirEntries, error) {
	if err := validRelative(dir); err != nil {
		return nil, err
	}
	entries, err := f.listPath(ctx, f.fullPath(dir))
	if err != nil {
		return nil, err
	}
	result := fs.DirEntries{}
	for _, e := range entries {
		remote := path.Join(dir, f.opt.Enc.ToStandardName(path.Base(e.Path)))
		if e.IsDir == 1 {
			result = append(result, fs.NewDir(remote, e.modTime()).SetID(strconv.FormatInt(e.ID, 10)))
		} else {
			result = append(result, &Object{fs: f, remote: remote, info: e})
		}
	}
	return result, nil
}
func (f *Fs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	if err := validRelative(remote); err != nil {
		return nil, err
	}
	e, err := f.statPath(ctx, f.fullPath(remote))
	if errors.Is(err, fs.ErrorDirNotFound) {
		return nil, fs.ErrorObjectNotFound
	}
	if err != nil {
		return nil, err
	}
	if e.IsDir == 1 {
		return nil, fs.ErrorIsDir
	}
	return &Object{fs: f, remote: remote, info: e}, nil
}
func (f *Fs) metadata(ctx context.Context, id int64, dlink bool) (entry, error) {
	q := values("method", "filemetas", "fsids", fmt.Sprintf("[%d]", id))
	if dlink {
		q.Set("dlink", "1")
	}
	var out struct {
		List []entry `json:"list"`
	}
	if err := f.get(ctx, metaAPI, q, &out); err != nil {
		return entry{}, err
	}
	if len(out.List) != 1 || out.List[0].ID != id {
		return entry{}, fs.ErrorObjectNotFound
	}
	return out.List[0], nil
}
func (f *Fs) Mkdir(ctx context.Context, dir string) error {
	if err := validRelative(dir); err != nil {
		return err
	}
	p := f.fullPath(dir)
	if p == "/" {
		return nil
	}
	e, err := f.statPath(ctx, p)
	if err == nil {
		if e.IsDir == 1 {
			return nil
		}
		return fs.ErrorIsFile
	}
	if !errors.Is(err, fs.ErrorObjectNotFound) && !errors.Is(err, fs.ErrorDirNotFound) {
		return err
	}
	// Create ancestors without escaping the configured remote root.
	parent := path.Dir(dir)
	if parent == "." {
		parent = ""
	}
	if dir != "" {
		if err = f.Mkdir(ctx, parent); err != nil {
			return err
		}
	} else if path.Dir(p) != "/" {
		return errors.New("baidu: configured root parent must exist")
	}
	var created entry
	err = f.post(ctx, "/api/create", nil, values("path", p, "isdir", "1", "rtype", "0"), &created)
	if errors.Is(err, fs.ErrorDirExists) {
		e, err = f.statPath(ctx, p)
		if err == nil && e.IsDir == 1 {
			return nil
		}
		return fs.ErrorIsFile
	}
	if err != nil {
		return err
	}
	if created.ID <= 0 || !sameDestination(created.Path, p) || created.IsDir != 1 {
		return errors.New("baidu: directory creation not confirmed")
	}
	return nil
}
func (f *Fs) manage(ctx context.Context, opera string, items any) error {
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	var out struct {
		TaskID int64 `json:"taskid"`
		Info   []struct {
			Errno *int `json:"errno"`
		} `json:"info"`
	}
	err = f.post(ctx, fileAPI, values("method", "filemanager", "opera", opera, "async", "0", "ondup", "fail"), values("filelist", string(raw)), &out)
	if err != nil {
		return err
	}
	if out.TaskID != 0 {
		for i := 0; i < 20; i++ {
			var task struct {
				List []struct {
					Status *int `json:"status"`
				} `json:"list"`
				Info []struct {
					Status *int `json:"status"`
				} `json:"info"`
			}
			if err = f.get(ctx, fileAPI, values("method", "taskquery", "taskid", strconv.FormatInt(out.TaskID, 10)), &task); err != nil {
				return err
			}
			var status *int
			if len(task.List) == 1 {
				status = task.List[0].Status
			} else if len(task.Info) == 1 {
				status = task.Info[0].Status
			}
			if status == nil {
				return errors.New("baidu: task status unavailable")
			}
			if *status == 0 {
				return nil
			}
			if *status == 3 {
				return errors.New("baidu: file operation failed")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
		}
		return errors.New("baidu: file operation still pending")
	}
	if len(out.Info) != 1 || out.Info[0].Errno == nil {
		return errors.New("baidu: file operation not confirmed")
	}
	return codeError(*out.Info[0].Errno)
}
func (f *Fs) Rmdir(ctx context.Context, dir string) error {
	if err := validRelative(dir); err != nil {
		return err
	}
	p := f.fullPath(dir)
	if p == "/" {
		return errors.New("baidu: cannot remove account root")
	}
	entries, err := f.listPath(ctx, p)
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return fs.ErrorDirectoryNotEmpty
	}
	return f.manage(ctx, "delete", []map[string]string{{"path": p}})
}
func (f *Fs) movePath(ctx context.Context, old, new string) error {
	if old == new {
		return nil
	}
	item := map[string]string{"path": old, "newname": path.Base(new)}
	op := "rename"
	if !samePath(path.Dir(old), path.Dir(new)) {
		op = "move"
		item["dest"] = path.Dir(new)
	}
	return f.manage(ctx, op, []map[string]string{item})
}
func (f *Fs) Move(ctx context.Context, src fs.Object, remote string) (fs.Object, error) {
	o, ok := src.(*Object)
	if !ok || o.fs.name != f.name {
		return nil, fs.ErrorCantMove
	}
	if err := validRelative(remote); err != nil {
		return nil, err
	}
	parent := path.Dir(remote)
	if parent == "." {
		parent = ""
	}
	if err := f.Mkdir(ctx, parent); err != nil {
		return nil, err
	}
	if err := f.movePath(ctx, o.info.Path, f.fullPath(remote)); err != nil {
		return nil, err
	}
	return f.NewObject(ctx, remote)
}
func (f *Fs) DirMove(ctx context.Context, src fs.Fs, old, new string) error {
	other, ok := src.(*Fs)
	if !ok || other.name != f.name {
		return fs.ErrorCantDirMove
	}
	if err := validRelative(old); err != nil {
		return err
	}
	if err := validRelative(new); err != nil {
		return err
	}
	if old == "" || new == "" {
		return fs.ErrorCantDirMove
	}
	dst := f.fullPath(new)
	if _, err := f.statPath(ctx, dst); err == nil {
		return fs.ErrorDirExists
	} else if !errors.Is(err, fs.ErrorObjectNotFound) && !errors.Is(err, fs.ErrorDirNotFound) {
		return err
	}
	parent := path.Dir(new)
	if parent == "." {
		parent = ""
	}
	if err := f.Mkdir(ctx, parent); err != nil {
		return err
	}
	return f.movePath(ctx, other.fullPath(old), dst)
}
func (f *Fs) About(ctx context.Context) (*fs.Usage, error) {
	var q struct {
		Total *int64 `json:"total"`
		Used  *int64 `json:"used"`
		Free  *int64 `json:"free"`
	}
	if err := f.get(ctx, "/api/quota", values("checkfree", "1", "checkexpire", "1"), &q); err != nil {
		return nil, err
	}
	if q.Total == nil || q.Used == nil {
		return nil, errors.New("baidu: quota unavailable")
	}
	if q.Free == nil {
		n := max(int64(0), *q.Total-*q.Used)
		q.Free = &n
	}
	return &fs.Usage{Total: q.Total, Used: q.Used, Free: q.Free}, nil
}
func (o *Object) Fs() fs.Info                                     { return o.fs }
func (o *Object) String() string                                  { return o.remote }
func (o *Object) Remote() string                                  { return o.remote }
func (o *Object) ModTime(context.Context) time.Time               { return o.info.modTime() }
func (o *Object) Size() int64                                     { return o.info.Size }
func (o *Object) Storable() bool                                  { return true }
func (o *Object) Hash(context.Context, hash.Type) (string, error) { return "", hash.ErrUnsupported }
func (o *Object) SetModTime(context.Context, time.Time) error     { return fs.ErrorCantSetModTime }
func (o *Object) Remove(ctx context.Context) error {
	return o.fs.manage(ctx, "delete", []map[string]string{{"path": o.info.Path}})
}

var _ fs.Fs = (*Fs)(nil)
var _ fs.Object = (*Object)(nil)
var _ fs.Mover = (*Fs)(nil)
var _ fs.DirMover = (*Fs)(nil)
var _ fs.Abouter = (*Fs)(nil)
