use super::*;

#[test]
fn reads_null_restore_keys_as_empty() {
    let request: GetCacheEntryDownloadUrlRequest =
        serde_json::from_str(r#"{"key":"k","version":"v","restore_keys":null,"metadata":{}}"#)
            .unwrap();
    assert!(request.restore_keys.is_empty(), "null is empty");
    let camel: GetCacheEntryDownloadUrlRequest =
        serde_json::from_str(r#"{"key":"k","version":"v","restoreKeys":["a"]}"#).unwrap();
    assert_eq!(camel.restore_keys, ["a"], "JSON names are accepted");
}
