# Wizmage Image Hider

Wizmage is a Manifest V3 browser extension that overlays page images and can optionally use AI-based people filtering. The repository also contains the Safari app/extension project under `Wizmage AI`; that project is not part of the Edge package.

## Development checks

Node.js 22 or newer is the only build-tool requirement. The package tooling has no third-party dependencies.

```text
npm run check        JavaScript syntax, manifest/resource, and package-policy checks
npm test             All checks, reproducibility builds, and real-browser DOM regressions
npm run test:browser Run only the real-browser DOM regression suite
npm run test:vm      Run shared-helper and service-worker VM regressions
npm run build:edge   Build and verify dist/edge
npm run verify:edge  Verify the existing dist/edge output against current source
```

`npm run check` validates every shipped JavaScript file with `node --check`. It also checks that local resources referenced by the manifest, HTML, and CSS are present in the package allowlist.

`npm test` automatically uses a locally installed Chrome, Chromium, or Edge browser when one is available. Its dependency-free headless fixture exercises the controller in a real DOM, including dynamic and CSS-only media discovery, site interaction propagation, asynchronous response generations, responsive sources, shadow DOM, large-tree scheduling, record pruning, and teardown. The VM suite also covers worker request bounds, timeouts, caching, queued settings writes, rejected storage writes, and settings propagation. When the selected headless browser supports command-line unpacked extensions, the run also smoke-tests the actual manifest, service worker, and content-script pause/resume path; unsupported branded builds report an explicit skip. Set `WIZMAGE_BROWSER` to an executable path to choose a browser. Set `WIZMAGE_REQUIRE_BROWSER=1` to make a missing browser fail instead of skip. Set `WIZMAGE_REQUIRE_MV3=1` to require the manifest-loaded smoke rather than permit that explicit skip; CI enables both requirements.

## Edge package

All three platform entry points call the same dependency-free Node packager:

```powershell
# PowerShell or Command Prompt
.\scripts\build-edge.ps1
.\scripts\build-edge.cmd

# Optional output directory
.\scripts\build-edge.ps1 -OutDir C:\temp\wizmage-edge
```

```bash
# macOS, Linux, or WSL
bash scripts/build-edge.sh
bash scripts/build-edge.sh /tmp/wizmage-edge
```

The default output is:

```text
dist/edge/unpacked/
dist/edge/wizmage-ai-edge.zip
```

The build is intentionally strict:

- `scripts/edge-package-files.json` is the single source of truth for shipped resources and accepted repository root entries.
- Only explicitly allowlisted files are copied. Repository metadata, scripts, documentation, `node_modules`, `dist`, and the Safari project cannot enter the extension package.
- An undeclared root entry fails the build instead of being silently copied or ignored.
- The unpacked tree and ZIP are checked against canonical current source bytes. Text package files use LF line endings. Store-specific `key` and `update_url` fields are removed from `manifest.json` when present, with manifest reserialization only when that removal is required; no other content transformation is permitted.
- ZIP entries have fixed ordering, timestamps, encoding, and storage settings, so the same canonical inputs produce an identical archive on Windows, macOS, and Linux.
- Every build uses a unique staging directory and an exclusive `.edge-package.lock`. Both staged artifacts must pass parity checks before publication, so stale ZIP entries cannot survive a rebuild or race with another build.
- Publication replaces the unpacked directory and ZIP under rollback protection. If either rename or final verification fails, the previous pair is restored. Two filesystem paths cannot be replaced as one atomic operation, so release readers should consume the output only after the build exits and the lock is gone.

Build metadata is not embedded in the extension, so it cannot alter the MV3 manifest or the source/package parity guarantee. The packager prints the manifest version, a deterministic source fingerprint, and the final ZIP SHA-256 for release provenance.

To load the development build in Edge, open `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/edge/unpacked`.

## Runtime layout

- `manifest.json` declares the extension entry points and resources.
- `shared.js` contains shared settings and URL-policy helpers.
- `content-controller.js` owns per-document filtering, visual state, bounded scanning, and cleanup.
- `js.js` is the small content-script bootstrap for effective settings and worker communication.
- `service_worker.js` owns extension settings, classification requests, and browser APIs.
- `popup.*` and `options.*` provide the extension controls.

For site safety, an extensionless cross-origin `<object>` or `<embed>` with no declared MIME type is left untouched when the browser does not expose its response type. In that case an image response is indistinguishable from an embedded HTML/PDF application without broader host permissions; known image MIME types/extensions and same-origin extensionless image responses are still filtered.

When adding a shipped resource, add it to `packageFiles` in `scripts/edge-package-files.json`. When adding a repository-level tooling file or directory, also declare its top-level name in `allowedRepositoryEntries`. CI runs the same checks and real-browser suite on Windows, macOS, and Linux, then requires all three generated ZIP files to be byte-for-byte identical.
