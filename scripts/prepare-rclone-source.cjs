'use strict';
// Apply reviewed, exact-version edits to an isolated build copy, never the module cache.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const source = path.resolve(__dirname, '../engine-src/rclone');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function prepare() {
  const seriesFile = path.join(source, 'patches/series.json');
  const series = JSON.parse(fs.readFileSync(seriesFile, 'utf8'));
  const dependency = JSON.parse(execFileSync('go', ['list', '-mod=readonly', '-m', '-json', 'github.com/rclone/rclone'], {cwd:source, encoding:'utf8'}));
  if (dependency.Version !== series.upstream || dependency.Replace) throw Error('Unexpected upstream module for patches');
  if (!dependency.Dir) {
    const downloaded = JSON.parse(execFileSync('go', ['mod', 'download', '-json', 'github.com/rclone/rclone'], {cwd:source, encoding:'utf8'}));
    if (downloaded.Version !== series.upstream || !downloaded.Dir) throw Error('Cannot obtain pinned upstream source');
    dependency.Dir = downloaded.Dir;
  }
  const build = path.join(source, '.build', 'patched');
  fs.mkdirSync(build, {recursive:true});
  const upstream = path.join(build, 'upstream');
  fs.rmSync(upstream, {recursive:true, force:true});
  fs.cpSync(dependency.Dir, upstream, {recursive:true});
  const patchedFiles = new Set(), applied = [];
  for (const patch of series.patches) {
    if (!/^[a-zA-Z0-9_/-]+\.go$/.test(patch.file) || patch.file.split('/').includes('..')) throw Error('Invalid patch path');
    const original = path.join(dependency.Dir, patch.file), input = fs.readFileSync(original);
    if (sha(input) !== patch.sourceSha256) throw Error('Upstream source drift: ' + patch.file);
    if (patchedFiles.has(original)) throw Error('Duplicate source patch: ' + patch.file);
    let output = input.toString('utf8');
    for (const edit of patch.replacements) {
      if (!edit.before || output.split(edit.before).length !== 2) throw Error('Patch context mismatch: ' + patch.id);
      output = output.replace(edit.before, () => edit.after);
    }
    const dest = path.join(upstream, patch.file);
    fs.chmodSync(dest, 0o600);fs.writeFileSync(dest, output);
    patchedFiles.add(original);
    applied.push({id:patch.id, file:patch.file, sourceSha256:patch.sourceSha256, patchedSha256:sha(output)});
  }
  // Go disallows overlays beneath GOMODCACHE. A generated -modfile selects
  // this verified build copy; the checked-in go.mod/go.sum remain unchanged.
  const modfile = path.join(build, 'rclone.mod');
  const mod = fs.readFileSync(path.join(source, 'go.mod'), 'utf8');
  fs.writeFileSync(modfile, mod + '\nreplace github.com/rclone/rclone => ' + JSON.stringify(upstream.replace(/\\/g, '/')) + '\n');
  fs.copyFileSync(path.join(source, 'go.sum'), path.join(build, 'rclone.sum'));
  fs.writeFileSync(path.join(build, 'manifest.json'), JSON.stringify({upstream:series.upstream, seriesSha256:sha(fs.readFileSync(seriesFile)), patches:applied}, null, 2)+'\n');
  return modfile;
}
if (require.main === module) console.log(prepare());
module.exports = {prepare};
