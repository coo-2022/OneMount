// OneMount's rclone distribution: upstream commands and backends, plus local backends.
package main

import (
	_ "github.com/coo-2022/OneMount/engine-src/rclone/backend/all"
	_ "github.com/rclone/rclone/backend/all"
	"github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/all"
)

func main() { cmd.Main() }
