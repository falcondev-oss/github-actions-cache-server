use super::*;

#[test]
fn clamps_ranges_to_the_object() {
    let range = |start, end| RangeRequest { start, end };
    assert_eq!(
        clamp_range(range(2, Some(100)), 10),
        Some(ByteRange { start: 2, end: 9 }),
        "end is clamped"
    );
    assert_eq!(
        clamp_range(range(3, None), 10),
        Some(ByteRange { start: 3, end: 9 }),
        "open"
    );
    assert_eq!(clamp_range(range(10, None), 10), None, "start past the end");
    assert_eq!(clamp_range(range(0, None), 0), None, "empty object");
}
