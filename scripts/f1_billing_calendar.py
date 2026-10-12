"""Pacific usage-report boundaries. No invoice claim, network or execution."""
import datetime as dt
import re
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc
PACIFIC = ZoneInfo('America/Los_Angeles')


def month_bounds(month):
    if type(month) is not str or not re.fullmatch(r'20[0-9]{2}-(?:0[1-9]|1[0-2])', month):
        raise ValueError('BILLING_MONTH_INVALID')
    year, number = map(int, month.split('-'))
    start = dt.datetime(year, number, 1, tzinfo=PACIFIC)
    end = dt.datetime(year + (number == 12), number % 12 + 1, 1, tzinfo=PACIFIC)
    # Python subtracts identical ZoneInfo objects in wall time; convert first.
    return start.astimezone(UTC), end.astimezone(UTC)


def billing_month(moment):
    if not isinstance(moment, dt.datetime) or moment.tzinfo is None:
        raise ValueError('BILLING_TIME_INVALID')
    return moment.astimezone(PACIFIC).strftime('%Y-%m')


def month_hours(month):
    start, end = month_bounds(month)
    return int((end-start).total_seconds()) // 3600
