# @swrm/preview-ios

iOS Simulator screenshot preview plugin for [swrm](https://github.com/ballinbigE/swrm).

Captures the booted iPhone simulator's screen via `xcrun simctl io booted screenshot` and serves it to the workspace right pane. macOS + Xcode required.

## Install

```sh
npm install @swrm/preview-ios
```

Then add to your `.swrmrc.json`:

```json
{
  "plugins": ["@swrm/preview-ios"]
}
```

The plugin matches any task whose worktree (or repo) contains an `ios/` directory. Cached for 1.5s to spare the simulator under polling.

## Falls back gracefully

When no simulator is booted (or you're on Linux/Windows), the plugin returns a 1×1 transparent PNG so the iframe layout doesn't break.

## License

Apache 2.0.
