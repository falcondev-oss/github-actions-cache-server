//! Generates the Twirp `CacheService` from `proto/cache.proto`, without a system `protoc`.

use std::path::PathBuf;

use prost::Message as _;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto");
    let descriptors = protox::compile(["cache.proto"], ["proto"])?;
    let out = PathBuf::from(std::env::var("OUT_DIR")?);
    prost_build::Config::new()
        .service_generator(twirp_build::service_generator())
        .compile_fds(descriptors.clone())?;
    pbjson_build::Builder::new()
        .register_descriptors(&descriptors.encode_to_vec())?
        .out_dir(out)
        .preserve_proto_field_names()
        .emit_fields()
        .ignore_unknown_fields()
        .build(&[".github.actions.results.api.v1"])?;
    Ok(())
}
