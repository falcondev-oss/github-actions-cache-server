use super::*;

#[test]
fn collects_repeated_and_bracketed_params() {
    let params = Params::parse(Some(
        "scopes=a&scopes=b&restoreKeys[]=x&restoreKeys[1]=y&key=k",
    ));
    assert_eq!(params.list("scopes"), ["a", "b"], "repeated");
    assert_eq!(params.list("restoreKeys"), ["x", "y"], "bracketed");
    assert_eq!(params.required("key").unwrap(), "k", "single");
    assert!(
        params.optional("scopes").is_err(),
        "a list is not a single value"
    );
}
