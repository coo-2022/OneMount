package cloud115

import (
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fstest"
	"github.com/rclone/rclone/fstest/fstests"
	"os"
	"testing"
)

// Explicit opt-in: fstests creates a random directory below this remote and
// removes only its own test data. Never run automatically against a user account.
func TestLive115(t *testing.T) {
	remote := os.Getenv("ONEMOUNT_115_TEST_REMOTE")
	if remote == "" {
		t.Skip("115 account not configured: set ONEMOUNT_115_TEST_REMOTE to a dedicated test directory")
	}
	fstest.Initialise()
	if *fstest.RemoteName != "" {
		t.Fatal("Use ONEMOUNT_115_TEST_REMOTE, not the global -remote flag")
	}
	info, _, _, _, err := fs.ConfigFs(remote)
	if err != nil || info.Name != "cloud115" {
		t.Fatal("Test remote must use the cloud115 backend")
	}
	fstests.Run(t, &fstests.Opt{RemoteName: remote, NilObject: (*Object)(nil)})
}
