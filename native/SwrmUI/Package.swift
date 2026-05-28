// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SwrmUI",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "SwrmUI", targets: ["SwrmUI"]),
    ],
    dependencies: [
        .package(path: "../SwrmCore"),
    ],
    targets: [
        .target(name: "SwrmUI", dependencies: ["SwrmCore"]),
        .testTarget(name: "SwrmUITests", dependencies: ["SwrmUI"]),
    ]
)
