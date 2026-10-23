# Cross-compiles a static binary on the build host for every target platform; no emulation.
FROM --platform=$BUILDPLATFORM ghcr.io/rust-cross/cargo-zigbuild:0.24 AS builder

ARG TARGETARCH
WORKDIR /app

COPY rust-toolchain.toml ./
RUN rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl

COPY Cargo.toml Cargo.lock ./
COPY src ./src

ARG BUILD_HASH
ENV BUILD_HASH=${BUILD_HASH}
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target,id=target-${TARGETARCH} \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-musl ;; \
      arm64) target=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && cargo zigbuild --release --locked --target "$target" \
    && cp "target/$target/release/github-actions-cache-server" /server

# --------------------------------------------

# Root, like the previous image, so existing volumes stay writable.
FROM gcr.io/distroless/static-debian12

# The default `.data/...` paths stay where the previous image kept them.
WORKDIR /app

COPY --from=builder /server /github-actions-cache-server

EXPOSE 3000
ENTRYPOINT ["/github-actions-cache-server"]
