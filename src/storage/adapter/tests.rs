use super::*;

#[test]
fn clamps_ranges_to_the_object() {
    let from = |start, end| RangeRequest {
        start: StartPosition::Index(start),
        end,
    };
    assert_eq!(
        clamp_range(from(2, EndPosition::Index(100)), 10),
        Some(ByteRange { start: 2, end: 9 }),
        "end is clamped"
    );
    assert_eq!(
        clamp_range(from(3, EndPosition::LastByte), 10),
        Some(ByteRange { start: 3, end: 9 }),
        "open"
    );
    let suffix = |length| RangeRequest {
        start: StartPosition::FromLast(length),
        end: EndPosition::LastByte,
    };
    assert_eq!(
        clamp_range(suffix(4), 10),
        Some(ByteRange { start: 6, end: 9 }),
        "suffix"
    );
    assert_eq!(
        clamp_range(suffix(40), 10),
        Some(ByteRange { start: 0, end: 9 }),
        "a long suffix is the whole object"
    );
    assert_eq!(
        clamp_range(from(10, EndPosition::LastByte), 10),
        None,
        "start past the end"
    );
    assert_eq!(
        clamp_range(from(0, EndPosition::LastByte), 0),
        None,
        "empty object"
    );
}
