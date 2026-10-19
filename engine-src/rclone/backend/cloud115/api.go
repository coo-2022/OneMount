package cloud115

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/lib/oauthutil"
	"golang.org/x/oauth2"
)

func readToken(m configmap.Mapper) (*oauth2.Token, error) {
	raw, _ := m.Get("token")
	var token oauth2.Token
	if json.Unmarshal([]byte(raw), &token) != nil || token.RefreshToken == "" {
		return nil, errors.New("cloud115: authorization required")
	}
	return &token, nil
}

// Refresh responses are wrapped in data, unlike standard OAuth. Keep error
// messages fixed, persist rotated tokens through rclone's encrypted config.
func (f *Fs) accessToken(ctx context.Context, rejected string) (string, error) {
	f.authMu.Lock()
	defer f.authMu.Unlock()
	if latest, e := readToken(f.mapper); e == nil && (latest.RefreshToken != f.token.RefreshToken || latest.Valid()) {
		f.token = latest
	}
	if f.token.Valid() && (rejected == "" || rejected != f.token.AccessToken) {
		return f.token.AccessToken, nil
	}
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(requestCtx, "POST", f.auth, strings.NewReader(url.Values{"refresh_token": {f.token.RefreshToken}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := f.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errors.New("cloud115: authorization refresh network failure")
	}
	defer resp.Body.Close()
	var result struct {
		Code  int64  `json:"code"`
		Error string `json:"error"`
		Errno int64  `json:"errno"`
		Data  struct {
			Access  string `json:"access_token"`
			Refresh string `json:"refresh_token"`
			Expires int64  `json:"expires_in"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&result) != nil || resp.StatusCode != 200 || result.Code != 0 || result.Errno != 0 || result.Error != "" || result.Data.Access == "" || result.Data.Refresh == "" || result.Data.Expires <= 0 {
		return "", errors.New("cloud115: authorization refresh rejected")
	}
	next := &oauth2.Token{AccessToken: result.Data.Access, RefreshToken: result.Data.Refresh, TokenType: "Bearer", Expiry: time.Now().Add(time.Duration(min(result.Data.Expires, 90*86400)) * time.Second)}
	if err = oauthutil.PutToken(f.name, f.mapper, next, false); err != nil {
		return "", errors.New("cloud115: authorization persistence failed")
	}
	f.token = next
	return next.AccessToken, nil
}
func pause(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (f *Fs) call(ctx context.Context, method, endpoint string, values url.Values, out any, whole, safeRetry bool) error {
	rejected := ""
	refreshed := false
	for attempt := 0; attempt < 4; attempt++ {
		if err := f.limiter.Wait(ctx); err != nil {
			return err
		}
		token, err := f.accessToken(ctx, rejected)
		if err != nil {
			return err
		}
		rejected = ""
		address := f.api + endpoint
		body := ""
		if method == "GET" {
			address += "?" + values.Encode()
		} else {
			body = values.Encode()
		}
		requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		req, _ := http.NewRequestWithContext(requestCtx, method, address, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("User-Agent", "CloudIsland/115")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := f.client.Do(req)
		if err != nil {
			cancel()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("cloud115: API network request failed")
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024+1))
		resp.Body.Close()
		cancel()
		if readErr != nil || len(raw) > 8*1024*1024 {
			return errors.New("cloud115: invalid API response")
		}
		var result struct {
			State bool            `json:"state"`
			Code  int64           `json:"code"`
			Data  json.RawMessage `json:"data"`
		}
		parseErr := json.Unmarshal(raw, &result)
		if !refreshed && (resp.StatusCode == 401 || (parseErr == nil && !result.State && (result.Code == 99 || strings.HasPrefix(strconv.FormatInt(result.Code, 10), "401")))) {
			rejected = token
			refreshed = true
			continue
		}
		if safeRetry && (resp.StatusCode == 429 || resp.StatusCode >= 500) && attempt < 3 {
			wait := time.Duration(1<<attempt) * time.Second
			if seconds, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil && seconds > 0 {
				wait = time.Duration(min(seconds, 30)) * time.Second
			}
			if err = pause(ctx, wait); err != nil {
				return err
			}
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("cloud115: API HTTP %d", resp.StatusCode)
		}
		if parseErr != nil {
			return errors.New("cloud115: invalid API response")
		}
		if !result.State {
			if result.Code == 430004 {
				return fs.ErrorObjectNotFound
			}
			return fmt.Errorf("cloud115: API rejected code=%d", result.Code)
		}
		if out != nil {
			if !whole {
				raw = result.Data
			}
			if json.Unmarshal(raw, out) != nil {
				return errors.New("cloud115: invalid API data")
			}
		}
		return nil
	}
	return errors.New("cloud115: API retry limit exceeded")
}
