package baidu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/object"
)

func TestMixedParentCaseAcrossPagesAndLookup(t *testing.T) {
	starts := []int{}
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("dir") != "/相册/Camera" {
			t.Error("request path was rewritten")
		}
		start, _ := strconv.Atoi(r.URL.Query().Get("start"))
		starts = append(starts, start)
		list := []entry{}
		for i := start; i < min(start+pageSize, 1003); i++ {
			parent := "/相册/Camera"
			if i%2 == 0 {
				parent = "/相册/camera"
			}
			list = append(list, item(fmt.Sprintf("%s/照片_%04d.JPG", parent, i), int64(i+1), 3))
		}
		reply(w, map[string]any{"errno": 0, "list": list})
	})
	list, err := f.List(context.Background(), "相册/Camera")
	if err != nil || len(list) != 1003 || len(starts) != 2 || starts[1] != 1000 {
		t.Fatalf("listing count=%d starts=%v err=%v", len(list), starts, err)
	}
	if list[1002].Remote() != "相册/Camera/照片_1002.JPG" {
		t.Fatal("display spelling changed")
	}
	o, err := f.NewObject(context.Background(), list[1002].Remote())
	if err != nil || o.(*Object).info.Path != "/相册/camera/照片_1002.JPG" {
		t.Fatalf("lookup did not retain provider spelling: %v", err)
	}
	if f.Features().CaseInsensitive {
		t.Fatal("must not advertise global case-insensitive semantics")
	}
}

func TestLookupPrefersExactLeafAndRejectsAmbiguity(t *testing.T) {
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"errno": 0, "list": []entry{item("/camera/Photo.JPG", 1, 3), item("/camera/photo.jpg", 2, 3)}})
	})
	for _, tc := range []struct {
		path string
		id   int64
	}{{"/camera/Photo.JPG", 1}, {"/Camera/photo.jpg", 2}, {"/Camera/Photo.JPG", 1}} {
		e, err := f.statPath(context.Background(), tc.path)
		if err != nil || e.ID != tc.id {
			t.Fatalf("lookup %q: id=%d err=%v", tc.path, e.ID, err)
		}
	}
	if _, err := f.statPath(context.Background(), "/Camera/PHOTO.JPG"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous lookup accepted: %v", err)
	}
}

func TestListingStillRejectsInvalidEntries(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		list         []entry
	}{
		{"parent", "entry parent mismatch", []entry{item("/Other/file", 1, 3)}},
		{"nested", "entry parent mismatch", []entry{item("/Camera/sub/file", 1, 3)}},
		{"relative", "invalid entry path", []entry{item("Camera/file", 1, 3)}},
		{"traversal", "invalid entry path", []entry{item("/Other/../Camera/file", 1, 3)}},
		{"id", "invalid entry ID", []entry{item("/camera/file", 0, 3)}},
		{"size", "negative entry size", []entry{item("/camera/file", 1, -1)}},
		{"duplicate", "repeated entry ID", []entry{item("/Camera/a", 1, 3), item("/camera/b", 1, 3)}},
		{"name", "repeated entry name", []entry{item("/Camera/a", 1, 3), item("/camera/a", 2, 3)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t, func(w http.ResponseWriter, r *http.Request) { reply(w, map[string]any{"errno": 0, "list": tc.list}) })
			_, err := f.List(context.Background(), "Camera")
			if err == nil || !strings.Contains(err.Error(), tc.reason) || !strings.Contains(err.Error(), "start=0 index=") {
				t.Fatalf("incorrect diagnostic: %v", err)
			}
		})
	}
}

func TestMixedCaseMetadataReadStillChecksIdentity(t *testing.T) {
	for _, change := range []string{"", "id", "size", "hash", "time", "parent"} {
		t.Run(change, func(t *testing.T) {
			e := item("/Camera/file", 9, 3)
			var base string
			calls := 0
			f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == metaAPI {
					calls++
					m := e
					m.Path = "/camera/file"
					m.Dlink = base + "/download"
					if calls > 1 {
						switch change {
						case "id":
							m.ID++
						case "size":
							m.Size++
						case "hash":
							m.MD5 = "new"
						case "time":
							m.Mtime++
						case "parent":
							m.Path = "/other/file"
						}
					}
					reply(w, map[string]any{"errno": 0, "list": []entry{m}})
				} else {
					w.Header().Set("Content-Range", "bytes 0-2/3")
					w.WriteHeader(206)
					io.WriteString(w, "abc")
				}
			})
			base = f.api
			o := &Object{fs: f, remote: "Camera/file", info: e}
			r, err := o.Open(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			b, err := io.ReadAll(r)
			r.Close()
			if change == "" {
				if err != nil || string(b) != "abc" || calls != 2 {
					t.Fatalf("read: %q %v", b, err)
				}
			} else if err == nil {
				t.Fatal("changed object accepted")
			}
		})
	}
}

func TestMkdirConfirmsParentCaseButNotWrongLeaf(t *testing.T) {
	for _, wrong := range []bool{false, true} {
		f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/create" {
				name := "/camera/New"
				if wrong {
					name = "/camera/Other"
				}
				e := item(name, 2, 0)
				e.IsDir = 1
				reply(w, e)
			} else {
				list := []entry{}
				if r.URL.Query().Get("dir") == "/" {
					e := item("/Camera", 1, 0)
					e.IsDir = 1
					list = append(list, e)
				}
				reply(w, map[string]any{"errno": 0, "list": list})
			}
		})
		err := f.Mkdir(context.Background(), "Camera/New")
		if (err != nil) != wrong {
			t.Fatalf("wrong=%v err=%v", wrong, err)
		}
	}
}

func TestOverwriteUsesProviderPathAndRejectsAmbiguity(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		precreates := 0
		f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("method") == "precreate" {
				precreates++
				r.ParseForm()
				if r.PostForm.Get("path") != "/camera/Photo.JPG" {
					t.Error("lost original server spelling")
				}
				reply(w, map[string]any{"errno": 0, "return_type": 2})
			} else {
				list := []entry{item("/camera/Photo.JPG", 1, 3)}
				if r.URL.Query().Get("dir") == "/" {
					e := item("/Camera", 3, 0)
					e.IsDir = 1
					list = []entry{e}
				} else if ambiguous {
					list = append(list, item("/camera/photo.jpg", 2, 3))
				}
				reply(w, map[string]any{"errno": 0, "list": list})
			}
		})
		name := "Camera/Photo.JPG"
		if ambiguous {
			name = "Camera/PHOTO.JPG"
		}
		src := object.NewStaticObjectInfo(name, time.Unix(100, 0), 3, true, nil, f)
		_, err := f.Put(context.Background(), bytes.NewReader([]byte("abc")), src)
		if ambiguous {
			if err == nil || !strings.Contains(err.Error(), "ambiguous") || precreates != 0 {
				t.Fatalf("ambiguous write: %v", err)
			}
		} else if err != nil || precreates != 1 {
			t.Fatalf("write: %v", err)
		}
	}
}

func TestRenameWithParentAliasAndCaseOnlyName(t *testing.T) {
	calls := 0
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		r.ParseForm()
		var list []map[string]string
		json.Unmarshal([]byte(r.PostForm.Get("filelist")), &list)
		if r.URL.Query().Get("opera") != "rename" || len(list) != 1 || list[0]["path"] != "/camera/file" || list[0]["newname"] != "FILE" {
			t.Error("incorrect rename")
		}
		reply(w, map[string]any{"errno": 0, "info": []any{map[string]int{"errno": 0}}})
	})
	if err := f.movePath(context.Background(), "/camera/file", "/Camera/FILE"); err != nil || calls != 1 {
		t.Fatal(err)
	}
}

func TestMissingFoldedLookupRemainsNotFound(t *testing.T) {
	f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"errno": 0, "list": []entry{item("/camera/a", 1, 3)}})
	})
	if _, err := f.statPath(context.Background(), "/Camera/missing"); !errors.Is(err, fs.ErrorObjectNotFound) {
		t.Fatal(err)
	}
}

func TestUploadCommitWithParentAlias(t *testing.T) {
	for _, bad := range []string{"", "parent", "leaf", "size"} {
		t.Run(bad, func(t *testing.T) {
			committed := false
			f := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Query().Get("method") {
				case "precreate":
					reply(w, map[string]any{"errno": 0, "return_type": 2, "uploadid": "rapid"})
				case "create":
					committed = true
					e := item("/camera/New.JPG", 2, 3)
					switch bad {
					case "parent":
						e.Path = "/Other/New.JPG"
					case "leaf":
						e.Path = "/camera/new.jpg"
					case "size":
						e.Size++
					}
					reply(w, e)
				case "list":
					list := []entry{}
					if r.URL.Query().Get("dir") == "/" {
						e := item("/Camera", 1, 0)
						e.IsDir = 1
						list = append(list, e)
					} else if committed {
						list = append(list, item("/camera/New.JPG", 2, 3))
					}
					reply(w, map[string]any{"errno": 0, "list": list})
				default:
					t.Error("unexpected request")
				}
			})
			src := object.NewStaticObjectInfo("Camera/New.JPG", time.Unix(100, 0), 3, true, nil, f)
			o, err := f.Put(context.Background(), bytes.NewReader([]byte("abc")), src)
			if bad == "" {
				if err != nil || o.(*Object).info.Path != "/camera/New.JPG" {
					t.Fatalf("commit: %v", err)
				}
			} else if err == nil {
				t.Fatal("incorrect commit accepted")
			}
		})
	}
}
