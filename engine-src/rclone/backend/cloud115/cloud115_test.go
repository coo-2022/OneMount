package cloud115

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/object"
	"github.com/rclone/rclone/lib/dircache"
	"github.com/rclone/rclone/lib/encoder"
	"golang.org/x/oauth2"
	"golang.org/x/time/rate"
)

type fixture struct {
	t        *testing.T
	fs       *Fs
	server   *httptest.Server
	mu       sync.Mutex
	files    map[string]entry
	bodies   map[string][]byte
	next     int
	pageSize int
	hook     func(http.ResponseWriter, *http.Request) bool
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	x := &fixture{t: t, files: map[string]entry{}, bodies: map[string][]byte{}, next: 10, pageSize: 200}
	x.server = httptest.NewServer(http.HandlerFunc(x.serve))
	t.Cleanup(x.server.Close)
	tok := &oauth2.Token{AccessToken: "PRIVATE_ACCESS", RefreshToken: "PRIVATE_REFRESH", TokenType: "Bearer", Expiry: time.Now().Add(time.Hour)}
	encoded, _ := json.Marshal(tok)
	m := configmap.Simple{"token": string(encoded)}
	f := &Fs{name: "test115", mapper: m, token: tok, client: x.server.Client(), api: x.server.URL, auth: x.server.URL + "/refresh", testServer: x.server.URL, limiter: rate.NewLimiter(rate.Inf, 1), opt: options{RootID: "0", Enc: encoder.Display | encoder.EncodeBackSlash | encoder.EncodeCtl | encoder.EncodeDel | encoder.EncodeInvalidUtf8 | encoder.EncodeRightSpace}}
	f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	f.dirs = dircache.New("", "0", f)
	f.features = (&fs.Features{CanHaveEmptyDirectories: true}).Fill(context.Background(), f)
	x.fs = f
	return x
}
func (x *fixture) add(parent, name string, data []byte, isDir bool) entry {
	x.next++
	e := entry{ID: fmt.Sprint(x.next), Parent: parent, Name: name, Category: "1", Size: int64(len(data)), SHA1: fmt.Sprintf("%X", sha1.Sum(data)), PickCode: fmt.Sprint(x.next), Mtime: 1700000000, UploadState: "1"}
	if isDir {
		e.Category = "0"
	}
	x.files[e.ID] = e
	x.bodies[e.ID] = append([]byte{}, data...)
	return e
}
func respond(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"state": true, "code": 0, "data": data})
}
func (x *fixture) serve(w http.ResponseWriter, r *http.Request) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.hook != nil && x.hook(w, r) {
		return
	}
	if strings.HasPrefix(r.URL.Path, "/open/") && r.Header.Get("Authorization") != "Bearer PRIVATE_ACCESS" {
		x.t.Error("missing API authorization")
	}
	_ = r.ParseForm()
	switch r.URL.Path {
	case "/open/ufile/files":
		entries := []entry{}
		for _, e := range x.files {
			if e.Parent == r.Form.Get("cid") {
				entries = append(entries, e)
			}
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
		offset, _ := strconv.Atoi(r.Form.Get("offset"))
		end := min(len(entries), offset+x.pageSize)
		if offset > len(entries) {
			offset = len(entries)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"state": true, "data": entries[offset:end], "count": len(entries), "offset": offset})
	case "/open/folder/add":
		e := x.add(r.Form.Get("pid"), r.Form.Get("file_name"), nil, true)
		respond(w, map[string]string{"file_id": e.ID})
	case "/open/ufile/downurl":
		e := x.files[r.Form.Get("pick_code")]
		respond(w, map[string]any{e.ID: map[string]any{"file_size": e.Size, "sha1": e.SHA1, "url": map[string]string{"url": x.server.URL + "/download/" + e.ID + "?PRIVATE_SIGNATURE"}}})
	case "/open/ufile/update":
		id := r.Form.Get("file_id")
		e, ok := x.files[id]
		if !ok {
			http.Error(w, "missing", 404)
			return
		}
		e.Name = r.Form.Get("file_name")
		x.files[id] = e
		respond(w, map[string]string{"file_name": e.Name})
	case "/open/ufile/delete":
		id := r.Form.Get("file_ids")
		delete(x.files, id)
		delete(x.bodies, id)
		respond(w, []string{id})
	case "/open/upload/init":
		// Simulate a server-side rapid upload for a known content hash.
		for id, data := range x.bodies {
			if strings.EqualFold(fmt.Sprintf("%X", sha1.Sum(data)), r.Form.Get("fileid")) && !x.files[id].isDir() {
				e := x.add(strings.TrimPrefix(r.Form.Get("target"), "U_1_"), r.Form.Get("file_name"), data, false)
				respond(w, map[string]any{"status": 2, "file_id": e.ID, "callback": []any{}})
				return
			}
		}
		http.Error(w, "not seeded", 400)
	default:
		if strings.HasPrefix(r.URL.Path, "/download/") {
			if r.Header.Get("Authorization") != "" {
				x.t.Error("token leaked to signed download")
			}
			if r.Header.Get("User-Agent") != "CloudIsland/115" {
				x.t.Error("download user agent mismatch")
			}
			data := x.bodies[strings.TrimPrefix(r.URL.Path, "/download/")]
			var start, end int
			if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil || end >= len(data) || start < 0 {
				http.Error(w, "range", 416)
				return
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
			w.WriteHeader(206)
			_, _ = w.Write(data[start : end+1])
			return
		}
		x.t.Log("unexpected fixture endpoint", r.Method, r.URL.Path)
		http.Error(w, "unknown", 404)
	}
}
func source(name string, data []byte) fs.ObjectInfo {
	return object.NewStaticObjectInfo(name, time.Now(), int64(len(data)), true, nil, nil)
}
func TestListPaginationUnicodeAndDuplicateNames(t *testing.T) {
	x := newFixture(t)
	x.pageSize = 1
	x.add("0", "中文 文件", []byte("body"), false)
	x.add("0", "folder", nil, true)
	list, err := x.fs.List(context.Background(), "")
	if err != nil || len(list) != 2 {
		t.Fatalf("%v: %v", list, err)
	}
	x.add("0", "中文 文件", []byte("another"), false)
	if _, err = x.fs.List(context.Background(), ""); err == nil {
		t.Fatal("ambiguous names accepted")
	}
	if _, err = x.fs.NewObject(context.Background(), "中文 文件"); err == nil {
		t.Fatal("ambiguous object accepted")
	}
}
func TestDirectoryLifecycleAndPathSafety(t *testing.T) {
	x := newFixture(t)
	ctx := context.Background()
	if err := x.fs.Mkdir(ctx, "中文/child "); err != nil {
		t.Fatal(err)
	}
	if err := x.fs.Rmdir(ctx, "中文"); !errors.Is(err, fs.ErrorDirectoryNotEmpty) {
		t.Fatal(err)
	}
	if err := x.fs.Rmdir(ctx, "中文/child "); err != nil {
		t.Fatal(err)
	}
	if err := x.fs.Rmdir(ctx, "中文"); err != nil {
		t.Fatal(err)
	}
	if err := x.fs.Rmdir(ctx, ""); err == nil {
		t.Fatal("root deleted")
	}
	for _, p := range []string{"../x", "/absolute", "a//b", "a/./b", "a/../b", "a\x00b"} {
		if err := x.fs.Mkdir(ctx, p); err == nil {
			t.Fatal("accepted", p)
		}
	}
}

func TestDirectoryRenamePreservesChildrenAndFlushesCache(t *testing.T) {
	x := newFixture(t)
	ctx := context.Background()
	if err := x.fs.Mkdir(ctx, "original/child"); err != nil {
		t.Fatal(err)
	}
	if err := x.fs.DirMove(ctx, x.fs, "original", "renamed 中文"); err != nil {
		t.Fatal(err)
	}
	if entries, err := x.fs.List(ctx, "renamed 中文"); err != nil || len(entries) != 1 {
		t.Fatal(err, entries)
	}
	if _, err := x.fs.List(ctx, "original"); !errors.Is(err, fs.ErrorDirNotFound) {
		t.Fatal(err)
	}
}
func TestDownloadRangeAndExpiredSignedLink(t *testing.T) {
	x := newFixture(t)
	e := x.add("0", "file", []byte("0123456789"), false)
	ctx := context.Background()
	obj, err := x.fs.NewObject(ctx, "file")
	if err != nil {
		t.Fatal(err)
	}
	expired := true
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasPrefix(r.URL.Path, "/download/") && expired {
			expired = false
			w.WriteHeader(403)
			return true
		}
		return false
	}
	reader, err := obj.Open(ctx, &fs.RangeOption{Start: 2, End: 5})
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(data) != "2345" {
		t.Fatalf("%q %v", data, err)
	}
	if got, _ := obj.Hash(ctx, hash.SHA1); got != strings.ToLower(e.SHA1) {
		t.Fatal(got)
	}
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasPrefix(r.URL.Path, "/download/") {
			_, _ = w.Write([]byte("0123456789"))
			return true
		}
		return false
	}
	if _, err = obj.Open(ctx, &fs.RangeOption{Start: 2, End: 5}); err == nil {
		t.Fatal("ignored Range accepted")
	}
}
func TestDownloadRejectsRedirectAndShortBody(t *testing.T) {
	x := newFixture(t)
	x.add("0", "file", []byte("0123456789"), false)
	obj, _ := x.fs.NewObject(context.Background(), "file")
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasPrefix(r.URL.Path, "/download/") {
			w.Header().Set("Location", "https://evil.example/PRIVATE")
			w.WriteHeader(302)
			return true
		}
		return false
	}
	if _, err := obj.Open(context.Background()); err == nil || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatal(err)
	}
	r := &downloadReader{body: io.NopCloser(strings.NewReader("short")), remaining: 10, cancel: func() {}}
	if _, err := io.ReadAll(r); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(err)
	}
}
func TestRapidUploadCreateOverwriteRenameDelete(t *testing.T) {
	x := newFixture(t)
	data := []byte("new bytes")
	x.add("0", "seed", data, false)
	old := x.add("0", "target", []byte("old bytes"), false)
	ctx := context.Background()
	obj, err := x.fs.Put(ctx, bytes.NewReader(data), source("target", data))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := x.files[old.ID]; ok {
		t.Fatal("old version not cleaned after confirmed commit")
	}
	if obj.(*Object).info.ID == old.ID {
		t.Fatal("old object reused")
	}
	moved, err := x.fs.Move(ctx, obj, "renamed 中文")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := moved.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("wrong content", err)
	}
	if err = moved.Remove(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = x.fs.NewObject(ctx, "renamed 中文"); !errors.Is(err, fs.ErrorObjectNotFound) {
		t.Fatal(err)
	}
	if _, err = x.fs.Put(ctx, bytes.NewReader(data), source("new file", data)); err != nil {
		t.Fatal(err)
	}
}
func TestFailedPublishRestoresPreviousName(t *testing.T) {
	x := newFixture(t)
	data := []byte("new bytes")
	x.add("0", "seed", data, false)
	old := x.add("0", "target", []byte("old bytes"), false)
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		_ = r.ParseForm()
		if r.URL.Path == "/open/ufile/update" && r.Form.Get("file_name") == "target" && r.Form.Get("file_id") != old.ID {
			w.WriteHeader(503)
			return true
		}
		return false
	}
	if _, err := x.fs.Put(context.Background(), bytes.NewReader(data), source("target", data)); err == nil {
		t.Fatal("failure hidden")
	}
	if x.files[old.ID].Name != "target" || string(x.bodies[old.ID]) != "old bytes" {
		t.Fatal("old content lost")
	}
}
func TestUploadSourceMismatchAndInvalidChallenge(t *testing.T) {
	x := newFixture(t)
	ctx := context.Background()
	data := []byte("abc")
	for _, input := range [][]byte{[]byte("a"), []byte("abcd")} {
		if _, err := x.fs.Put(ctx, bytes.NewReader(input), source("file", data)); err == nil {
			t.Fatal("size mismatch accepted")
		}
	}
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/open/upload/init" {
			respond(w, map[string]any{"status": 7, "sign_key": "key", "sign_check": "0-99999"})
			return true
		}
		return false
	}
	if _, err := x.fs.Put(ctx, bytes.NewReader(data), source("file", data)); err == nil || !strings.Contains(err.Error(), "challenge") {
		t.Fatal(err)
	}
}
func TestAPITransientRetryAndNoBlindMutationRetry(t *testing.T) {
	x := newFixture(t)
	reads, writes := 0, 0
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/open/ufile/files" {
			reads++
			if reads == 1 {
				w.WriteHeader(429)
				return true
			}
		}
		if r.URL.Path == "/open/folder/add" {
			writes++
			w.WriteHeader(503)
			return true
		}
		return false
	}
	if _, err := x.fs.List(context.Background(), ""); err != nil || reads != 2 {
		t.Fatal(err, reads)
	}
	if err := x.fs.Mkdir(context.Background(), "new"); err == nil || writes != 1 {
		t.Fatal(err, writes)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := x.fs.List(cancelled, ""); err == nil {
		t.Fatal("cancel ignored")
	}
}
func TestRefreshPersistsRotatedTokenOnceUnderConcurrency(t *testing.T) {
	x := newFixture(t)
	x.fs.token.Expiry = time.Now().Add(-time.Hour)
	raw, _ := json.Marshal(x.fs.token)
	x.fs.mapper.Set("token", string(raw))
	var count atomic.Int32
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/refresh" {
			count.Add(1)
			respond(w, map[string]any{"access_token": "NEW_ACCESS", "refresh_token": "NEW_REFRESH", "expires_in": 7200})
			return true
		}
		return false
	}
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tok, err := x.fs.accessToken(context.Background(), ""); err != nil || tok != "NEW_ACCESS" {
				t.Errorf("refresh: %v", err)
			}
		}()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatal(count.Load())
	}
	stored, err := readToken(x.fs.mapper)
	if err != nil || stored.RefreshToken != "NEW_REFRESH" {
		t.Fatal("rotation not saved")
	}
}
func TestUntrustedTransferAddresses(t *testing.T) {
	x := newFixture(t)
	for _, address := range []string{"http://evil.test/a", "https://115.com.evil.test/a", "https://u:PRIVATE@115.com/a", "file:///a", "https://127.0.0.1/a"} {
		if _, err := x.fs.downloadURL(address); err == nil {
			t.Fatal(address)
		}
	}
	file, err := os.CreateTemp(t.TempDir(), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	err = x.fs.uploadOSS(context.Background(), file, 0, uploadInfo{}, uploadToken{Endpoint: "https://evil.test"})
	if err == nil || !strings.Contains(err.Error(), "untrusted") {
		t.Fatal(err)
	}
}

func TestMultipartUploadChallengeCallbackAndVisibleCommit(t *testing.T) {
	x := newFixture(t)
	data := bytes.Repeat([]byte("115-中文"), 1024*1024)
	var stagedName string
	var uploaded []byte
	challenge := false
	parts := 0
	callbackVerified := false
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/open/upload/init" {
			_ = r.ParseForm()
			stagedName = r.Form.Get("file_name")
			if r.Form.Get("sign_key") == "" {
				respond(w, map[string]any{"status": 7, "sign_key": "challenge", "sign_check": "3-19"})
				return true
			}
			challenge = r.Form.Get("sign_val") == fmt.Sprintf("%X", sha1.Sum(data[3:20]))
			respond(w, map[string]any{"status": 1, "bucket": "upload-bucket", "object": "objects/test", "callback": map[string]string{"callback": "{\"callbackUrl\":\"https://proapi.115.com/callback\"}", "callback_var": "{}"}})
			return true
		}
		if r.URL.Path == "/open/upload/get_token" {
			respond(w, map[string]string{"endpoint": x.server.URL, "AccessKeyId": "TEST_KEY", "AccessKeySecret": "TEST_SECRET", "SecurityToken": "TEST_SESSION"})
			return true
		}
		if r.URL.Path == "/upload-bucket/objects/test" {
			if r.Header.Get("Authorization") == "Bearer PRIVATE_ACCESS" {
				t.Error("API token leaked to OSS")
			}
			if r.Method == "POST" && r.URL.Query().Has("uploads") {
				w.Header().Set("Content-Type", "application/xml")
				_, _ = io.WriteString(w, "<InitiateMultipartUploadResult><Bucket>upload-bucket</Bucket><Key>objects/test</Key><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>")
				return true
			}
			if r.Method == "PUT" {
				part, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				uploaded = append(uploaded, part...)
				parts++
				w.Header().Set("ETag", fmt.Sprintf("\"part-%d\"", parts))
				return true
			}
			if r.Method == "POST" && r.URL.Query().Get("uploadId") == "fixture-upload" {
				cb, _ := base64.StdEncoding.DecodeString(r.Header.Get("x-oss-callback"))
				callbackVerified = strings.Contains(string(cb), "proapi.115.com/callback")
				x.add("0", stagedName, uploaded, false)
				respond(w, map[string]any{})
				return true
			}
		}
		return false
	}
	obj, err := x.fs.Put(context.Background(), bytes.NewReader(data), source("multipart.bin", data))
	if err != nil {
		t.Fatal(err)
	}
	if !challenge || !callbackVerified || parts != 2 || !bytes.Equal(uploaded, data) || obj.Size() != int64(len(data)) {
		t.Fatal("multipart upload contract failed", challenge, callbackVerified, parts)
	}
	if _, err = x.fs.NewObject(context.Background(), "multipart.bin"); err != nil {
		t.Fatal(err)
	}
}

func TestCancelledMultipartAbortsWithoutPublishing(t *testing.T) {
	x := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aborted := false
	x.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/upload-bucket/object" {
			return false
		}
		if r.Method == "POST" {
			_, _ = io.WriteString(w, "<InitiateMultipartUploadResult><Bucket>upload-bucket</Bucket><Key>object</Key><UploadId>abort-test</UploadId></InitiateMultipartUploadResult>")
			return true
		}
		if r.Method == "PUT" {
			cancel()
			w.WriteHeader(503)
			return true
		}
		if r.Method == "DELETE" {
			aborted = true
			w.WriteHeader(204)
			return true
		}
		return false
	}
	file, err := os.CreateTemp(t.TempDir(), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_, _ = file.WriteString("body")
	u := uploadInfo{Bucket: "upload-bucket", Object: "object"}
	u.Callback.Callback = "{}"
	u.Callback.Variables = "{}"
	err = x.fs.uploadOSS(ctx, file, 4, u, uploadToken{Endpoint: x.server.URL, Key: "KEY", Secret: "SECRET", Security: "SESSION"})
	if err == nil || !aborted {
		t.Fatal("cancel did not abort multipart upload", err, aborted)
	}
}
