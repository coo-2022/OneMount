// Package cloud115 implements the public 115 Open Platform API. Protocol field
// names were checked against OpenListTeam/115-sdk-go (Apache-2.0); this adapter
// uses rclone's configuration, directory cache and filesystem interfaces.
package cloud115

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/fshttp"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/lib/dircache"
	"github.com/rclone/rclone/lib/encoder"
	"golang.org/x/oauth2"
	"golang.org/x/time/rate"
)

func init() {
	fs.Register(&fs.RegInfo{Name: "cloud115", Description: "115 (Open Platform)", NewFs: NewFs,
		Options: []fs.Option{
			{Name: "client_id", Help: "Approved 115 App ID used for desktop PKCE authorization."},
			{Name: "token", Help: "OAuth token supplied by CloudIsland QR authorization.", Sensitive: true, Hide: fs.OptionHideBoth},
			{Name: "root_folder_id", Help: "Root folder ID (0 is the account root).", Default: "0", Advanced: true},
			{Name: config.ConfigEncoding, Help: config.ConfigEncodingHelp, Default: encoder.Display | encoder.EncodeBackSlash | encoder.EncodeCtl | encoder.EncodeDel | encoder.EncodeInvalidUtf8 | encoder.EncodeRightSpace, Advanced: true},
		}})
}

type options struct {
	RootID string               `config:"root_folder_id"`
	Enc    encoder.MultiEncoder `config:"encoding"`
}
type Fs struct {
	name, root string
	opt        options
	features   *fs.Features
	client     *http.Client
	mapper     configmap.Mapper
	token      *oauth2.Token
	authMu     sync.Mutex
	mutations  sync.Mutex
	dirs       *dircache.DirCache
	limiter    *rate.Limiter
	api, auth  string
	// HTTP is only allowed on this in-process fixture address, never a config option.
	testServer string
}
type entry struct {
	ID          string `json:"fid"`
	Parent      string `json:"pid"`
	Category    string `json:"fc"`
	Name        string `json:"fn"`
	PickCode    string `json:"pc"`
	SHA1        string `json:"sha1"`
	Size        int64  `json:"fs"`
	Mtime       int64  `json:"upt"`
	UploadState string `json:"fta"`
}

func (e entry) isDir() bool { return e.Category == "0" }

type Object struct {
	fs     *Fs
	remote string
	info   entry
}

func NewFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	f := &Fs{name: name, root: strings.Trim(root, "/"), mapper: m, api: "https://proapi.115.com", auth: "https://passportapi.115.com/open/refreshToken", opt: options{RootID: "0"}}
	if err := validPath(f.root); err != nil {
		return nil, err
	}
	if err := configstruct.Set(m, &f.opt); err != nil {
		return nil, err
	}
	if !numericID(f.opt.RootID) {
		return nil, errors.New("cloud115: invalid root folder ID")
	}
	var err error
	f.token, err = readToken(m)
	if err != nil {
		return nil, err
	}
	f.client = fshttp.NewClient(ctx)
	f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	f.limiter = rate.NewLimiter(rate.Every(500*time.Millisecond), 1)
	f.dirs = dircache.New(f.root, f.opt.RootID, f)
	f.features = (&fs.Features{CanHaveEmptyDirectories: true}).Fill(ctx, f)
	err = f.dirs.FindRoot(ctx, false)
	if (errors.Is(err, fs.ErrorDirNotFound) || errors.Is(err, fs.ErrorIsFile)) && f.root != "" {
		original := f.root
		f.root = path.Dir(original)
		if f.root == "." {
			f.root = ""
		}
		f.dirs = dircache.New(f.root, f.opt.RootID, f)
		if _, e := f.NewObject(ctx, path.Base(original)); e == nil {
			return f, fs.ErrorIsFile
		}
		f.root = original
		f.dirs = dircache.New(f.root, f.opt.RootID, f)
	}
	if err != nil && !errors.Is(err, fs.ErrorDirNotFound) {
		return nil, err
	}
	return f, nil
}
func numericID(s string) bool {
	if s == "" || len(s) > 30 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func validPath(s string) error {
	if strings.HasPrefix(s, "/") || strings.ContainsRune(s, 0) {
		return errors.New("cloud115: invalid relative path")
	}
	if s != "" {
		for _, p := range strings.Split(s, "/") {
			if p == "" || p == "." || p == ".." {
				return errors.New("cloud115: invalid relative path")
			}
		}
	}
	return nil
}
func (f *Fs) Name() string                          { return f.name }
func (f *Fs) Root() string                          { return f.root }
func (f *Fs) String() string                        { return "115 Open Platform" }
func (f *Fs) Precision() time.Duration              { return fs.ModTimeNotSupported }
func (f *Fs) Hashes() hash.Set                      { return hash.NewHashSet(hash.SHA1) }
func (f *Fs) Features() *fs.Features                { return f.features }
func (o *Object) Fs() fs.Info                       { return o.fs }
func (o *Object) Remote() string                    { return o.remote }
func (o *Object) String() string                    { return o.remote }
func (o *Object) Size() int64                       { return o.info.Size }
func (o *Object) ModTime(context.Context) time.Time { return time.Unix(o.info.Mtime, 0) }
func (o *Object) Storable() bool                    { return true }
func (o *Object) Hash(_ context.Context, t hash.Type) (string, error) {
	if t != hash.SHA1 {
		return "", hash.ErrUnsupported
	}
	return strings.ToLower(o.info.SHA1), nil
}
func (o *Object) SetModTime(context.Context, time.Time) error { return fs.ErrorCantSetModTime }

func (f *Fs) list(ctx context.Context, id string) ([]entry, error) {
	var result []entry
	seen := map[string]bool{}
	for offset := 0; ; {
		var page struct {
			Data   []entry `json:"data"`
			Count  int64   `json:"count"`
			Offset int     `json:"offset"`
		}
		q := url.Values{"cid": {id}, "limit": {"200"}, "offset": {fmt.Sprint(offset)}, "show_dir": {"1"}, "cur": {"1"}, "o": {"file_name"}, "asc": {"1"}}
		if err := f.call(ctx, "GET", "/open/ufile/files", q, &page, true, true); err != nil {
			return nil, err
		}
		if page.Offset != offset || page.Count < 0 {
			return nil, errors.New("cloud115: invalid listing pagination")
		}
		for _, e := range page.Data {
			if !numericID(e.ID) || e.Name == "" || e.Size < 0 || (e.Category != "0" && e.Category != "1") || seen[e.ID] {
				return nil, errors.New("cloud115: invalid or repeated listing entry")
			}
			seen[e.ID] = true
			result = append(result, e)
		}
		offset += len(page.Data)
		if int64(offset) >= page.Count {
			break
		}
		if len(page.Data) == 0 {
			return nil, errors.New("cloud115: incomplete listing")
		}
	}
	return result, nil
}
func (f *Fs) lookup(ctx context.Context, parent, name string) (entry, error) {
	entries, err := f.list(ctx, parent)
	if err != nil {
		return entry{}, err
	}
	var found *entry
	for _, e := range entries {
		if f.opt.Enc.ToStandardName(e.Name) == name {
			if found != nil {
				return entry{}, errors.New("cloud115: duplicate names in directory; resolve them in 115 first")
			}
			copy := e
			found = &copy
		}
	}
	if found == nil {
		return entry{}, fs.ErrorObjectNotFound
	}
	return *found, nil
}
func (f *Fs) FindLeaf(ctx context.Context, parent, leaf string) (string, bool, error) {
	e, err := f.lookup(ctx, parent, leaf)
	if errors.Is(err, fs.ErrorObjectNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !e.isDir() {
		return "", false, fs.ErrorIsFile
	}
	return e.ID, true, nil
}
func (f *Fs) CreateDir(ctx context.Context, parent, leaf string) (string, error) {
	var result struct {
		ID string `json:"file_id"`
	}
	err := f.call(ctx, "POST", "/open/folder/add", url.Values{"pid": {parent}, "file_name": {f.opt.Enc.FromStandardName(leaf)}}, &result, false, false)
	if err != nil {
		return "", err
	}
	if !numericID(result.ID) {
		return "", errors.New("cloud115: invalid created directory")
	}
	return result.ID, nil
}
func (f *Fs) List(ctx context.Context, dir string) (fs.DirEntries, error) {
	if err := validPath(dir); err != nil {
		return nil, err
	}
	id, err := f.dirs.FindDir(ctx, dir, false)
	if err != nil {
		return nil, err
	}
	entries, err := f.list(ctx, id)
	if err != nil {
		return nil, err
	}
	var out fs.DirEntries
	names := map[string]bool{}
	for _, e := range entries {
		name := f.opt.Enc.ToStandardName(e.Name)
		if name == "" || name == "." || name == ".." || strings.Contains(name, "/") || names[name] {
			return nil, errors.New("cloud115: ambiguous directory names")
		}
		names[name] = true
		remote := path.Join(dir, name)
		if e.isDir() {
			f.dirs.Put(remote, e.ID)
			out = append(out, fs.NewDir(remote, time.Unix(e.Mtime, 0)).SetID(e.ID))
		} else {
			if e.UploadState != "" && e.UploadState != "1" {
				return nil, errors.New("cloud115: directory contains incomplete upload")
			}
			out = append(out, &Object{fs: f, remote: remote, info: e})
		}
	}
	return out, nil
}
func (f *Fs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	if err := validPath(remote); err != nil {
		return nil, err
	}
	leaf, parent, err := f.dirs.FindPath(ctx, remote, false)
	if errors.Is(err, fs.ErrorDirNotFound) {
		return nil, fs.ErrorObjectNotFound
	}
	if err != nil {
		return nil, err
	}
	e, err := f.lookup(ctx, parent, leaf)
	if err != nil {
		return nil, err
	}
	if e.isDir() {
		return nil, fs.ErrorIsDir
	}
	if e.UploadState != "" && e.UploadState != "1" {
		return nil, errors.New("cloud115: upload is not complete")
	}
	return &Object{fs: f, remote: remote, info: e}, nil
}
func (f *Fs) Mkdir(ctx context.Context, dir string) error {
	if err := validPath(dir); err != nil {
		return err
	}
	f.mutations.Lock()
	defer f.mutations.Unlock()
	_, err := f.dirs.FindDir(ctx, dir, true)
	return err
}
func (f *Fs) removeID(ctx context.Context, id, parent string) error {
	return f.call(ctx, "POST", "/open/ufile/delete", url.Values{"file_ids": {id}, "parent_id": {parent}}, nil, false, false)
}
func (f *Fs) Rmdir(ctx context.Context, dir string) error {
	if err := validPath(dir); err != nil {
		return err
	}
	f.mutations.Lock()
	defer f.mutations.Unlock()
	id, err := f.dirs.FindDir(ctx, dir, false)
	if err != nil {
		return err
	}
	if id == "0" || id == f.opt.RootID {
		return errors.New("cloud115: refusing to remove account root")
	}
	entries, err := f.list(ctx, id)
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return fs.ErrorDirectoryNotEmpty
	}
	parentPath := path.Dir(path.Join(f.root, dir))
	if parentPath == "." {
		parentPath = ""
	}
	rootCache := dircache.New("", f.opt.RootID, f)
	parent, err := rootCache.FindDir(ctx, parentPath, false)
	if err != nil {
		return err
	}
	if err = f.removeID(ctx, id, parent); err == nil {
		f.dirs.FlushDir(dir)
	}
	return err
}
func (o *Object) Remove(ctx context.Context) error {
	o.fs.mutations.Lock()
	defer o.fs.mutations.Unlock()
	current, err := o.fs.NewObject(ctx, o.remote)
	if err != nil {
		return err
	}
	if current.(*Object).info.ID != o.info.ID {
		return errors.New("cloud115: file changed before deletion")
	}
	return o.fs.removeID(ctx, o.info.ID, current.(*Object).info.Parent)
}
func (f *Fs) rename(ctx context.Context, id, name string) error {
	return f.call(ctx, "POST", "/open/ufile/update", url.Values{"file_id": {id}, "file_name": {f.opt.Enc.FromStandardName(name)}}, nil, false, false)
}
func (f *Fs) Move(ctx context.Context, src fs.Object, remote string) (fs.Object, error) {
	source, ok := src.(*Object)
	if !ok || source.fs.name != f.name {
		return nil, fs.ErrorCantMove
	}
	if err := validPath(remote); err != nil {
		return nil, err
	}
	f.mutations.Lock()
	defer f.mutations.Unlock()
	leaf, parent, err := f.dirs.FindPath(ctx, remote, true)
	if err != nil {
		return nil, err
	}
	// Across-directory moves need two API mutations. Let rclone copy and verify
	// before deleting instead of pretending that this is an atomic rename.
	if source.info.Parent != parent {
		return nil, fs.ErrorCantMove
	}
	if f.opt.Enc.ToStandardName(source.info.Name) == leaf {
		return &Object{fs: f, remote: remote, info: source.info}, nil
	}
	if _, err = f.lookup(ctx, parent, leaf); !errors.Is(err, fs.ErrorObjectNotFound) {
		if err != nil {
			return nil, err
		}
		return nil, fs.ErrorCantMove
	}
	if err = f.rename(ctx, source.info.ID, leaf); err != nil {
		return nil, err
	}
	e := source.info
	e.Name = f.opt.Enc.FromStandardName(leaf)
	return &Object{fs: f, remote: remote, info: e}, nil
}
func (f *Fs) DirCacheFlush() { f.dirs.ResetRoot() }

// Same-parent directory rename is one server operation. Across-parent renames
// fall back to rclone's normal copy/delete path instead of a partial two-step move.
func (f *Fs) DirMove(ctx context.Context, src fs.Fs, srcRemote, dstRemote string) error {
	source, ok := src.(*Fs)
	if !ok || source.name != f.name {
		return fs.ErrorCantDirMove
	}
	if err := validPath(srcRemote); err != nil {
		return err
	}
	if err := validPath(dstRemote); err != nil {
		return err
	}
	f.mutations.Lock()
	defer f.mutations.Unlock()
	sourceID, sourceParent, _, destParent, destLeaf, err := f.dirs.DirMove(ctx, source.dirs, source.root, srcRemote, f.root, dstRemote)
	if err != nil {
		return err
	}
	if sourceParent != destParent {
		return fs.ErrorCantDirMove
	}
	if sourceID == f.opt.RootID || sourceID == "0" {
		return fs.ErrorCantDirMove
	}
	if err = f.rename(ctx, sourceID, destLeaf); err != nil {
		return err
	}
	source.dirs.FlushDir(srcRemote)
	f.dirs.FlushDir(dstRemote)
	return nil
}

var _ fs.Fs = (*Fs)(nil)
var _ fs.Object = (*Object)(nil)
var _ fs.Mover = (*Fs)(nil)
var _ fs.DirMover = (*Fs)(nil)
