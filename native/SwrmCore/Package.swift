// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SwrmCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "SwrmCore", targets: ["SwrmCore"]),
    ],
    targets: [
        .target(name: "SwrmCore"),
        .testTarget(name: "SwrmCoreTests", dependencies: ["SwrmCore"]),
    ]
)
