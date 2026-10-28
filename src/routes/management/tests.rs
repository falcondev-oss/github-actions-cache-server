use axum::http::Request;

use super::*;

async fn query<T: DeserializeOwned + Send>(query: &str) -> Result<T, ApiError> {
    let (mut parts, ()) = Request::get(format!("/?{query}"))
        .body(())
        .unwrap()
        .into_parts();
    Query::<T>::from_request_parts(&mut parts, &())
        .await
        .map(|Query(value)| value)
}

#[tokio::test]
async fn collects_repeated_and_bracketed_params() {
    let matched: MatchQuery =
        query("scopes=a&scopes=b&restoreKeys[]=x&restoreKeys[]=y&primaryKey=k&repoId=1&version=v")
            .await
            .unwrap();
    assert_eq!(matched.scopes, ["a", "b"], "repeated");
    assert_eq!(matched.restore_keys, ["x", "y"], "bracketed");
    assert_eq!(matched.primary_key, "k", "single");
    assert!(
        query::<EntryFilter>("key=a&key=b").await.is_err(),
        "a list is not a single value"
    );
}

#[tokio::test]
async fn bounds_pagination() {
    let defaults: Pagination = query("").await.unwrap();
    assert_eq!(
        (defaults.items_per_page.0, defaults.page.get()),
        (20, 1),
        "defaults"
    );
    for invalid in ["itemsPerPage=0", "itemsPerPage=101", "page=0"] {
        assert!(query::<Pagination>(invalid).await.is_err(), "{invalid}");
    }
}
