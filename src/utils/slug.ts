const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const TZ = 'America/New_York';

function getETComponents(date: Date): { month: string; day: number; hour: number; ampm: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
  });

  const parts = formatter.formatToParts(date);
  const month = parts.find((p) => p.type === 'month')!.value.toLowerCase();
  const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
  const hour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const ampm = parts.find((p) => p.type === 'dayPeriod')!.value.toLowerCase();

  return { month, day, hour, ampm };
}

export function generateMarketSlug(assetPrefix: string, date: Date): string {
  const { month, day, hour, ampm } = getETComponents(date);
  return `${assetPrefix}-${month}-${day}-${hour}${ampm}-et`;
}

export function generateUpcomingMarketSlugs(assetPrefix: string, hoursAhead: number): string[] {
  const slugs: string[] = [];
  const now = new Date();

  // Round down to current hour
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);

  for (let i = 0; i < hoursAhead; i++) {
    const targetDate = new Date(currentHour.getTime() + i * 60 * 60 * 1000);
    slugs.push(generateMarketSlug(assetPrefix, targetDate));
  }

  return slugs;
}

export function parseSlugDate(slug: string): Date | null {
  // Pattern: {prefix}-{month}-{day}-{hour}{am/pm}-et
  const match = slug.match(/^.+-([a-z]+)-(\d+)-(\d+)(am|pm)-et$/);
  if (!match) return null;

  const [, monthStr, dayStr, hourStr, ampm] = match;
  const monthIndex = MONTHS.indexOf(monthStr);
  if (monthIndex === -1) return null;

  let hour = parseInt(hourStr, 10);
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const day = parseInt(dayStr, 10);

  // Assume current year, create date in ET then convert to UTC
  const now = new Date();
  const year = now.getFullYear();

  // Create a date string and parse in ET timezone
  const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;

  // Get UTC offset for ET at this date
  const testDate = new Date(dateStr);
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  // Parse by creating date in local, then adjusting
  // Simpler approach: use the offset
  const utcDate = new Date(
    Date.UTC(year, monthIndex, day, hour, 0, 0)
  );

  // Get the offset for ET at this time
  const etTime = new Date(utcDate.toLocaleString('en-US', { timeZone: TZ }));
  const offset = utcDate.getTime() - etTime.getTime();

  return new Date(utcDate.getTime() + offset);
}
