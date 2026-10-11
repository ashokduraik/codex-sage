/**
 * Calendar date picker used by admin filters. Stores YYYY-MM-DD (local calendar
 * day) so list queries can convert that day to UTC bounds at the call site.
 */
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';

/** Days in a week; used to pad the month grid. */
const WEEKDAY_COUNT = 7;

/**
 * Parses a YYYY-MM-DD value as a local calendar date.
 * @param value Raw string from the URL or caller.
 * @returns Local midnight Date, or null when the value is not a real day.
 */
export function parseCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/**
 * Formats a local Date as YYYY-MM-DD for URL and query params.
 * @param date Local calendar date.
 * @returns Stable day key.
 */
export function toCalendarDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calendar-day picker. `value` / `onChange` use YYYY-MM-DD or empty string.
 *
 * @param props Control identity, current day, and optional inclusive bounds.
 * @returns Labeled trigger plus popover month grid.
 */
export function DatePicker({ id, label, value, onChange, minDate = '', maxDate = '', className }) {
  const { t, i18n } = useTranslation();
  const selected = parseCalendarDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(selected ?? new Date()));

  useEffect(() => {
    const nextSelected = parseCalendarDate(value);
    if (nextSelected) {
      setVisibleMonth(startOfMonth(nextSelected));
    }
  }, [value]);

  const locale = i18n.language || undefined;
  const weekStartsOn = useMemo(() => weekStartIndex(locale ?? 'en'), [locale]);
  const weekdays = useMemo(() => {
    const resolvedLocale = locale ?? 'en';
    const formatter = new Intl.DateTimeFormat(resolvedLocale, { weekday: 'short' });
    // 4 Jan 2026 is a Sunday — a fixed origin for weekday names.
    const sunday = new Date(2026, 0, 4);
    return Array.from({ length: WEEKDAY_COUNT }, (_, index) => {
      const day = new Date(sunday);
      day.setDate(sunday.getDate() + ((weekStartsOn + index) % WEEKDAY_COUNT));
      return formatter.format(day);
    });
  }, [locale, weekStartsOn]);
  const cells = useMemo(() => monthCells(visibleMonth, weekStartsOn), [visibleMonth, weekStartsOn]);
  const todayKey = toCalendarDateString(new Date());
  const selectedKey = selected ? toCalendarDateString(selected) : '';
  const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(visibleMonth);
  const displayValue = selected
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(selected)
    : t('common.pickDate');

  /**
   * Commits a day and closes the popover.
   * @param date Selected local day.
   */
  function chooseDate(date) {
    onChange(toCalendarDateString(date));
    setOpen(false);
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className={cn('w-full justify-start font-normal', !selected && 'text-muted-foreground')}
            aria-label={label}
          >
            <CalendarIcon aria-hidden="true" />
            <span className="truncate">{displayValue}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[18rem] p-3">
          <div className="mb-2 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('common.previousMonth')}
              onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <div className="flex-1 text-center text-sm font-medium">{monthTitle}</div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('common.nextMonth')}
              onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[0.7rem] text-muted-foreground">
            {weekdays.map((weekday) => (
              <div key={weekday} aria-hidden="true" className="py-1">
                {weekday}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {cells.map((date, index) => {
              if (!date) {
                return <div key={`pad-${index}`} />;
              }
              const key = toCalendarDateString(date);
              const disabled = isDateOutOfRange(date, minDate, maxDate);
              const isSelected = key === selectedKey;
              const isToday = key === todayKey;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={key}
                  aria-pressed={isSelected}
                  disabled={disabled}
                  onClick={() => chooseDate(date)}
                  className={cn(
                    'h-8 w-8 rounded-md text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40',
                    isSelected && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                    !isSelected && isToday && 'border border-brand text-brand',
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          {selected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 w-full"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {t('common.clearDate')}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );

  /**
   * Locale week start: 0 Sunday … 6 Saturday. Falls back to Monday.
   * @param resolvedLocale BCP 47 tag from i18n.
   * @returns Week-start weekday index.
   */
  function weekStartIndex(resolvedLocale) {
    try {
      const info = new Intl.Locale(resolvedLocale).weekInfo;
      if (!info || typeof info.firstDay !== 'number') {
        return 1;
      }
      return info.firstDay === 7 ? 0 : info.firstDay % WEEKDAY_COUNT;
    } catch {
      return 1;
    }
  }

  /**
   * Builds a month grid padded with empty cells for the locale week start.
   * @param month Any date in the displayed month.
   * @param weekStart Week-start index (0 Sunday).
   * @returns Cells in row-major order; `null` is a leading/trailing pad.
   */
  function monthCells(month, weekStart) {
    const first = startOfMonth(month);
    const leading = (first.getDay() - weekStart + WEEKDAY_COUNT) % WEEKDAY_COUNT;
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    /** @type {Array<Date | null>} */
    const nextCells = [];
    for (let pad = 0; pad < leading; pad += 1) {
      nextCells.push(null);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      nextCells.push(new Date(first.getFullYear(), first.getMonth(), day));
    }
    while (nextCells.length % WEEKDAY_COUNT !== 0) {
      nextCells.push(null);
    }
    return nextCells;
  }

  /**
   * True when `date` is outside an inclusive YYYY-MM-DD min/max range.
   * @param date Candidate day.
   * @param min Inclusive minimum YYYY-MM-DD, or empty.
   * @param max Inclusive maximum YYYY-MM-DD, or empty.
   * @returns Whether the day must not be selectable.
   */
  function isDateOutOfRange(date, min, max) {
    const key = toCalendarDateString(date);
    if (min && key < min) {
      return true;
    }
    if (max && key > max) {
      return true;
    }
    return false;
  }
}

/**
 * First day of the month that contains `date`.
 * @param date Any local date in the target month.
 * @returns Local midnight on day 1.
 */
function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Shifts a month by `delta` months without carrying the day-of-month.
 * @param date Month to shift.
 * @param delta Signed month offset.
 * @returns First day of the resulting month.
 */
function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}
