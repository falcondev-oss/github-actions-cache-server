use chrono::FixedOffset;

use super::*;

#[test]
fn schedules_follow_local_wall_clock_time() {
    let berlin = FixedOffset::east_opt(2 * 3600).unwrap();
    let india = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
    let at = |zone: FixedOffset, time: &str| {
        DateTime::parse_from_rfc3339(time)
            .unwrap()
            .with_timezone(&zone)
    };
    let noon = "2026-10-24T12:00:00Z";
    assert_eq!(
        next_run(&at(berlin, noon), 24 * 60),
        at(berlin, "2026-10-24T22:00:00Z"),
        "daily at local midnight"
    );
    assert_eq!(
        next_run(&at(india, noon), 60),
        at(india, "2026-10-24T12:30:00Z"),
        "hourly on the local hour"
    );
    assert_eq!(
        next_run(&at(berlin, "2026-10-24T12:05:00Z"), 5),
        at(berlin, "2026-10-24T12:10:00Z"),
        "a boundary moves on to the next one"
    );
}

#[test]
fn schedules_pass_over_dst_changes_like_cron() {
    let at = |zone: chrono_tz::Tz, time: &str| {
        DateTime::parse_from_rfc3339(time)
            .unwrap()
            .with_timezone(&zone)
    };
    let berlin = |time: &str| at(chrono_tz::Europe::Berlin, time);
    // 02:00 local is skipped on 2026-03-29: runs resume at 03:00 local.
    let before_gap = berlin("2026-03-29T00:59:58Z");
    assert_eq!(
        next_run(&before_gap, 5),
        berlin("2026-03-29T01:00:00Z"),
        "spring, 5 minutes"
    );
    assert_eq!(
        next_run(&before_gap, 60),
        berlin("2026-03-29T01:00:00Z"),
        "spring, hourly"
    );
    // 02:00-03:00 local repeats on 2026-10-25.
    let first_pass = berlin("2026-10-25T00:00:00Z");
    assert_eq!(
        next_run(&first_pass, 5),
        berlin("2026-10-25T00:05:00Z"),
        "first pass"
    );
    assert_eq!(
        next_run(&first_pass, 60),
        berlin("2026-10-25T02:00:00Z"),
        "hourly moves on"
    );
    let second_pass = berlin("2026-10-25T01:00:30Z");
    assert_eq!(
        next_run(&second_pass, 5),
        berlin("2026-10-25T01:05:00Z"),
        "second pass"
    );
    // Santiago skips midnight on 2026-09-06: the daily run is at 01:00 local.
    let santiago = |time: &str| at(chrono_tz::America::Santiago, time);
    assert_eq!(
        next_run(&santiago("2026-09-06T03:59:58Z"), 24 * 60),
        santiago("2026-09-06T04:00:00Z"),
        "skipped midnight"
    );
}
