use super::*;

#[test]
fn parses_block_ids() {
    let uuid = "00000000-0000-0000-0000-000000000000";
    let block_id = |index: &str| BASE64.encode(format!("{uuid}{index:0>12}"));
    assert_eq!(chunk_index(&block_id("7")), Some(7), "48-byte uuid + index");

    let mut buildx = vec![0_u8; 64];
    buildx[16..20].copy_from_slice(&42_u32.to_be_bytes());
    assert_eq!(
        chunk_index(&BASE64.encode(buildx)),
        Some(42),
        "64-byte buildx id"
    );

    assert_eq!(chunk_index(&BASE64.encode("short")), None, "unknown length");
}

#[test]
fn parses_single_ranges() {
    let range = |value: &'static str| {
        let mut headers = HeaderMap::new();
        headers.insert(RANGE, HeaderValue::from_static(value));
        parse_range(&headers)
    };
    assert_eq!(
        range("bytes=5-9"),
        Some(RangeRequest {
            start: 5,
            end: Some(9)
        }),
        "bounded"
    );
    assert_eq!(
        range("Bytes=5-"),
        Some(RangeRequest {
            start: 5,
            end: None
        }),
        "open-ended"
    );
    assert_eq!(range("bytes=-5"), None, "suffix ranges are served whole");
    assert_eq!(range("bytes=0-1,4-5"), None, "multi-range is served whole");
    assert_eq!(range("bytes=9-5"), None, "inverted");
    assert_eq!(
        range("bytes=9007199254740992-"),
        None,
        "beyond a safe integer"
    );
}
