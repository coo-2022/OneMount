package baidu

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/object"
	"github.com/rclone/rclone/lib/pacer"
	"golang.org/x/oauth2"
)

type testTokens struct{ expired int }

func (t *testTokens) Token() (*oauth2.Token, error) {
	return &oauth2.Token{AccessToken: fmt.Sprintf("private-token-%d", t.expired)}, nil
}
func (t *testTokens) Expire() error { t.expired++; return nil }
func fixture(t *testing.T, h http.HandlerFunc) *Fs {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	ctx, ci := fs.AddConfig(context.Background())
	ci.LowLevelRetries = 3
	f := &Fs{name: "test", api: s.URL, pcs: s.URL, testServer: s.URL, client: s.Client(), tokens: &testTokens{}, pacer: fs.NewPacer(ctx, pacer.NewDefault(pacer.MinSleep(time.Millisecond), pacer.MaxSleep(2*time.Millisecond)))}
	f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	f.features = (&fs.Features{CanHaveEmptyDirectories: true}).Fill(ctx, f)
	return f
}
func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func item(p string, id, size int64) entry {
	return entry{ID: id, Path: p, Size: size, Mtime: 100, MD5: "version"}
}
func TestListPagesAndChinesePaths(t *testing.T) {
	count := 0
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("access_token") != "private-token-0" {
			t.Error("missing token")
		}
		if r.URL.Query().Get("dir") != "/资料" {
			t.Error("wrong encoded path")
		}
		result := []entry{}
		if r.URL.Query().Get("start") == "0" {
			for i := 0; i < pageSize; i++ {
				result = append(result, item(fmt.Sprintf("/资料/%d.txt", i), int64(i+1), 2))
			}
		} else {
			result = append(result, item("/资料/中文 空格.txt", 1001, 3))
		}
		count++
		reply(w, map[string]any{"errno": 0, "list": result})
	})
	entries, err := f.List(context.Background(), "资料")
	if err != nil || len(entries) != 1001 || entries[1000].Remote() != "资料/中文 空格.txt" || count != 2 {
		t.Fatalf("list: count=%d err=%v", len(entries), err)
	}
	if _, err = f.List(context.Background(), "../escape"); err == nil {
		t.Fatal("accepted path escape")
	}
}
func TestRefreshAndRetryNeverExposeResponseSecrets(t *testing.T) {
	calls := 0
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			reply(w, map[string]any{"errno": -6, "errmsg": "private-token-0"})
		case 2:
			w.WriteHeader(429)
		case 3:
			w.WriteHeader(503)
		default:
			reply(w, map[string]any{"errno": 0, "total": 100, "used": 40})
		}
	})
	// Auth rejection plus transient errors require enough low-level attempts.
	f.pacer.SetRetries(5)
	q, err := f.About(context.Background())
	if err != nil || *q.Free != 60 || f.tokens.(*testTokens).expired != 1 {
		t.Fatalf("quota=%v err=%v calls=%d", q, err, calls)
	}
}
func TestErrorSanitizationAndCancellation(t *testing.T) {
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"errno": 12345, "errmsg": "private-token-0 secret=SECRET"})
	})
	_, err := f.About(context.Background())
	if err == nil || strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "private-token") {
		t.Fatal("unsafe error", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = f.List(ctx, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestRangeReadRedirectAndMetadataRecheck(t *testing.T) {
	for _, bad := range []string{"", "ignored", "wrong-range", "changed", "short"} {
		t.Run(bad, func(t *testing.T) {
			metas := 0
			var base string
			e := item("/file", 9, 6)
			f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					t.Error("bearer leaked")
				}
				switch r.URL.Path {
				case metaAPI:
					metas++
					m := e
					m.Dlink = base + "/redirect"
					if bad == "changed" && metas > 1 {
						m.MD5 = "changed"
					}
					reply(w, map[string]any{"errno": 0, "list": []entry{m}})
				case "/redirect":
					if r.URL.Query().Get("access_token") == "" {
						t.Error("missing initial query token")
					}
					w.Header().Set("Location", "/download")
					w.WriteHeader(302)
				case "/download":
					if r.URL.Query().Get("access_token") != "" {
						t.Error("token copied onto redirect")
					}
					if r.Header.Get("Range") != "bytes=2-4" || r.Header.Get("User-Agent") != "pan.baidu.com" {
						t.Error("range or UA missing")
					}
					if bad == "ignored" {
						io.WriteString(w, "abcdef")
						return
					}
					cr := "bytes 2-4/6"
					if bad == "wrong-range" {
						cr = "bytes 0-2/6"
					}
					w.Header().Set("Content-Range", cr)
					w.WriteHeader(206)
					if bad == "short" {
						io.WriteString(w, "c")
					} else {
						io.WriteString(w, "cde")
					}
				}
			})
			base = f.api
			o := &Object{fs: f, remote: "file", info: e}
			body, err := o.Open(context.Background(), &fs.RangeOption{Start: 2, End: 4})
			var data []byte
			if err == nil {
				data, err = io.ReadAll(body)
				body.Close()
			}
			if bad == "" {
				if err != nil || string(data) != "cde" || metas != 2 {
					t.Fatalf("read %q err=%v", data, err)
				}
			} else if err == nil {
				t.Fatal("accepted " + bad)
			}
		})
	}
}
func TestTransferHosts(t *testing.T) {
	f := &Fs{}
	for _, u := range []string{"https://evil.example/file", "http://d.pcs.baidu.com/file", "https://d.pcs.baidu.com.evil.test/file", "https://user:pass@d.pcs.baidu.com/file", "https://d.pcs.baidu.com:8080/file"} {
		if _, e := f.transferURL(u); e == nil {
			t.Fatal("accepted", u)
		}
	}
	for _, u := range []string{"https://d.pcs.baidu.com/file", "https://cdn.baidupcs.com/file"} {
		if _, e := f.transferURL(u); e != nil {
			t.Fatal(e)
		}
	}
}
func TestUploadSnapshotSlicesAndCommit(t *testing.T) {
	for _, failure := range []string{"", "slice", "commit", "size", "empty"} {
		t.Run(failure, func(t *testing.T) {
			data := bytes.Repeat([]byte("x"), sliceSize+7)
			if failure == "empty" {
				data = nil
			}
			var host string
			uploaded := map[int][]byte{}
			committed := false
			precreated := false
			target := "/中文.bin"
			e := item(target, 99, int64(len(data)))
			f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/rest/2.0/pcs/file":
					reply(w, map[string]any{"error_code": 0, "servers": []any{map[string]string{"server": host}}})
				case "/rest/2.0/pcs/superfile2":
					if failure == "slice" {
						reply(w, map[string]any{"error_code": 31296})
						return
					}
					file, _, err := r.FormFile("file")
					if err != nil {
						t.Error(err)
						return
					}
					b, _ := io.ReadAll(file)
					file.Close()
					part, _ := strconv.Atoi(r.URL.Query().Get("partseq"))
					uploaded[part] = b
					reply(w, map[string]any{"md5": fmt.Sprintf("%x", md5.Sum(b))})
				case "/api/create":
					committed = true
					reply(w, e)
				case fileAPI:
					switch r.URL.Query().Get("method") {
					case "precreate":
						_ = r.ParseForm()
						if r.PostForm.Get("rtype") != "3" || r.PostForm.Get("path") != target {
							t.Error("wrong overwrite target")
						}
						var hashes []string
						_ = json.Unmarshal([]byte(r.PostForm.Get("block_list")), &hashes)
						if len(hashes) != 2 || hashes[0] != fmt.Sprintf("%x", md5.Sum(data[:sliceSize])) {
							t.Error("invalid block hashes")
						}
						precreated = true
						reply(w, map[string]any{"errno": 0, "uploadid": "upload1", "return_type": 1, "block_list": []int{0, 1}})
					case "create":
						if failure == "commit" {
							reply(w, map[string]any{"errno": -10})
							return
						}
						if len(uploaded) != 2 {
							t.Error("premature commit")
						}
						committed = true
						m := e
						if failure == "size" {
							m.Size--
						}
						reply(w, m)
					case "list":
						list := []entry{}
						if committed {
							list = append(list, e)
						}
						reply(w, map[string]any{"errno": 0, "list": list})
					}
				}
			})
			host = f.api
			src := object.NewStaticObjectInfo("中文.bin", time.Unix(100, 0), int64(len(data)), true, nil, f)
			obj, err := f.Put(context.Background(), bytes.NewReader(data), src)
			if failure == "empty" {
				if !errors.Is(err, fs.ErrorCantUploadEmptyFiles) || committed || precreated {
					t.Fatal("empty file must be rejected without a remote mutation", err)
				}
			} else if failure == "" {
				if err != nil || obj.Size() != int64(len(data)) || !committed {
					t.Fatal(err)
				}
				if len(data) > 0 && !bytes.Equal(append(uploaded[0], uploaded[1]...), data) {
					t.Fatal("data mismatch")
				}
			} else if err == nil {
				t.Fatal("unconfirmed upload accepted")
			}
			if failure == "slice" && committed {
				t.Fatal("committed failed slice")
			}
			if failure == "empty" && precreated {
				t.Fatal("empty file precreated")
			}
		})
	}
}
func TestNonEmptyRmdirAndPerFileErrors(t *testing.T) {
	mutations := 0
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("method") == "list" {
			reply(w, map[string]any{"errno": 0, "list": []entry{item("/dir/child", 1, 0)}})
		} else {
			mutations++
			reply(w, map[string]any{"errno": 0, "info": []any{map[string]int{"errno": -10}}})
		}
	})
	if err := f.Rmdir(context.Background(), "dir"); !errors.Is(err, fs.ErrorDirectoryNotEmpty) || mutations != 0 {
		t.Fatal(err)
	}
	if err := f.manage(context.Background(), "delete", []string{"/x"}); err == nil {
		t.Fatal("ignored per-file failure")
	}
}
func TestMoveUsesAbsoluteRootDestination(t *testing.T) {
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.URL.Query().Get("opera") != "move" {
			t.Error("wrong operation")
		}
		var list []map[string]string
		_ = json.Unmarshal([]byte(r.PostForm.Get("filelist")), &list)
		if len(list) != 1 || list[0]["dest"] != "/" || list[0]["newname"] != "new" {
			t.Error("incorrect move")
		}
		reply(w, map[string]any{"errno": 0, "info": []any{map[string]int{"errno": 0}}})
	})
	if err := f.movePath(context.Background(), "/folder/old", "/new"); err != nil {
		t.Fatal(err)
	}
}
