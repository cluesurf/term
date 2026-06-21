mod calendar {
    use chrono::{DateTime, Utc, TimeZone, Datelike, Timelike, Months};
    fn at(millis: i64) -> DateTime<Utc> {
        Utc.timestamp_millis_opt(millis).single().unwrap_or_else(|| Utc.timestamp_opt(0, 0).single().unwrap())
    }
    pub fn format(millis: i64) -> String { at(millis).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string() }
    pub fn parse(text: String) -> i64 {
        DateTime::parse_from_rfc3339(&text).map(|date| date.timestamp_millis()).unwrap_or(0)
    }
    pub fn year(millis: i64) -> i64 { at(millis).year() as i64 }
    pub fn month(millis: i64) -> i64 { at(millis).month() as i64 }
    pub fn day(millis: i64) -> i64 { at(millis).day() as i64 }
    pub fn hour(millis: i64) -> i64 { at(millis).hour() as i64 }
    pub fn minute(millis: i64) -> i64 { at(millis).minute() as i64 }
    pub fn second(millis: i64) -> i64 { at(millis).second() as i64 }
    pub fn weekday(millis: i64) -> i64 { at(millis).weekday().num_days_from_sunday() as i64 }
    pub fn build(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
        Utc.with_ymd_and_hms(year as i32, month as u32, day as u32, hour as u32, minute as u32, second as u32)
            .single()
            .map(|date| date.timestamp_millis())
            .unwrap_or(0)
    }
    pub fn add_months(millis: i64, count: i64) -> i64 {
        let date = at(millis);
        let shifted = if count >= 0 {
            date.checked_add_months(Months::new(count as u32))
        } else {
            date.checked_sub_months(Months::new((-count) as u32))
        };
        shifted.map(|d| d.timestamp_millis()).unwrap_or(millis)
    }
    pub fn add_years(millis: i64, count: i64) -> i64 { add_months(millis, count * 12) }
}
