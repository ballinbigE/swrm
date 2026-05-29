import Foundation

/// Watches a directory for content changes via a DispatchSource on its file
/// descriptor. Coalesces bursts (debounce) and invokes `onChange` on the main
/// queue. Pure Foundation — works cross-platform and under `swift test`.
public final class FolderWatcher {
    private let url: URL
    private let onChange: () -> Void
    private let debounceInterval: TimeInterval
    private let queue = DispatchQueue(label: "swrm.folderwatcher")
    private var source: DispatchSourceFileSystemObject?
    private var debounceWork: DispatchWorkItem?

    public init(url: URL, debounceInterval: TimeInterval = 0.2, onChange: @escaping () -> Void) {
        self.url = url
        self.debounceInterval = debounceInterval
        self.onChange = onChange
    }

    deinit { stop() }

    public func start() {
        stop()
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .extend],
            queue: queue
        )
        src.setEventHandler { [weak self] in self?.scheduleChange() }
        // Capture fd by value: cancel() runs this handler asynchronously, and on a
        // deinit-triggered stop() `self` is already nil — a `[weak self]` guard
        // would skip the close and leak the descriptor.
        src.setCancelHandler { close(fd) }
        source = src
        src.resume()
    }

    public func stop() {
        debounceWork?.cancel()
        debounceWork = nil
        source?.cancel()
        source = nil
    }

    private func scheduleChange() {
        debounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            DispatchQueue.main.async { self?.onChange() }
        }
        debounceWork = work
        queue.asyncAfter(deadline: .now() + debounceInterval, execute: work)
    }
}
