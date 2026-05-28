// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SwrmCore",
    products: [
        .library(name: "SwrmCore", targets: ["SwrmCore"]),
    ],
    targets: [
        .target(name: "SwrmCore"),
        .testTarget(name: "SwrmCoreTests", dependencies: ["SwrmCore"]),
    ]
)
