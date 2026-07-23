/**
 * Acuity Scraper Adapter
 * Extracts scheduling data from public Acuity pages without API access
 *
 * Uses Playwright for reliable browser automation and handles:
 * - Service (appointment type) extraction
 * - Availability dates
 * - Time slots
 * - Provider information
 */

import type { Browser, Page } from 'playwright-core';

const getChromium = async () => {
  try {
    const pw = await import('playwright-core');
    return pw.chromium;
  } catch {
    try {
      // @ts-ignore — fallback for environments with playwright instead of playwright-core
      const pw = await import('playwright');
      return pw.chromium;
    } catch {
      throw new Error(
        'playwright-core or playwright is required for the scraper adapter. Install with: pnpm add playwright-core'
      );
    }
  }
};
import { Effect } from 'effect';
import type { Service, Provider, TimeSlot, AcuityError, InfrastructureError, SchedulingResult } from '../../core/types.js';
import { Errors } from '../../core/types.js';
import { observePageOp } from '../../shared/metrics.js';

// Keep E for internal class methods (deprecated, not worth migrating)
const E = {
  right: <A>(a: A) => ({ _tag: 'Right' as const, right: a }),
  left: <E>(e: E) => ({ _tag: 'Left' as const, left: e }),
  isLeft: <E, A>(e: { _tag: 'Left'; left: E } | { _tag: 'Right'; right: A }): e is { _tag: 'Left'; left: E } =>
    e._tag === 'Left',
};
type Either<E, A> = { _tag: 'Left'; left: E } | { _tag: 'Right'; right: A };

// =============================================================================
// TYPES
// =============================================================================

export interface ScraperConfig {
  /** Base URL for the Acuity scheduling page */
  baseUrl: string;
  /** Browser launch options */
  headless?: boolean;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** User agent string */
  userAgent?: string;
  /** Path to Chromium executable (for Lambda/serverless) */
  executablePath?: string;
  /** Additional browser launch args */
  launchArgs?: string[];
}

export interface ScrapedService {
  id: string;
  name: string;
  description: string;
  duration: number;
  price: number;
  category?: string;
  href: string;
}

export interface ScrapedAvailability {
  dates: string[];
  serviceId: string;
  providerId?: string;
}

export interface ScrapedTimeSlot {
  time: string;
  datetime: string;
  available: boolean;
}

// =============================================================================
// SCRAPER CLASS
// =============================================================================

export class AcuityScraper {
  private config: ScraperConfig & { headless: boolean; timeout: number; userAgent: string };
  private browser: Browser | null = null;

  constructor(config: ScraperConfig) {
    this.config = {
      headless: true,
      timeout: 30000,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...config,
    };
  }

  /**
   * Initialize browser instance
   */
  async init(): Promise<void> {
    if (!this.browser) {
      const chromium = await getChromium();
      this.browser = await chromium.launch({
        headless: this.config.headless,
        executablePath: this.config.executablePath,
        args: this.config.launchArgs,
      });
    }
  }

  /**
   * Close browser instance
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Create a new page with standard configuration
   */
  private async createPage(): Promise<Page> {
    if (!this.browser) {
      await this.init();
    }
    const page = await this.browser!.newPage({
      userAgent: this.config.userAgent,
    });
    page.setDefaultTimeout(this.config.timeout);
    return page;
  }

  /**
   * Extract all services (appointment types) from the scheduling page
   */
  async scrapeServices(): Promise<Either<AcuityError | InfrastructureError, ScrapedService[]>> {
    let page: Page | null = null;

    try {
      page = await this.createPage();
      // Time the entire catalog-scrape page interaction — navigation plus
      // the selector wait that unblocks downstream DOM reads. Downstream
      // `page.evaluate` cost is small relative to network + render.
      await observePageOp('scrape_catalog', async () => {
        await page!.goto(this.config.baseUrl, { waitUntil: 'networkidle' });

        // Wait for appointment types to load
        await page!.waitForSelector('.select-item, .appointment-type-item, [data-testid="appointment-type"]', {
          timeout: 10000,
        }).catch(() => {
          // Some Acuity pages use different selectors
        });
      });

      // Try multiple selector patterns for robustness
      const services = await page.evaluate(() => {
        const results: ScrapedService[] = [];

        // Pattern 1: Standard select-item layout
        const selectItems = document.querySelectorAll('.select-item');
        selectItems.forEach((item) => {
          const link = item.querySelector('a');
          const nameEl = item.querySelector('.appointment-type-name, .type-name, h3');
          const descEl = item.querySelector('.type-description, .description, p');
          const durationEl = item.querySelector('.duration, .time-duration');
          const priceEl = item.querySelector('.price, .cost');

          if (nameEl && link) {
            // Extract appointment type ID from href
            const href = link.getAttribute('href') || '';
            const idMatch = href.match(/appointmentType=(\d+)/);
            const id = idMatch ? idMatch[1] : `generated-${Date.now()}-${Math.random().toString(36).slice(2)}`;

            // Parse duration (e.g., "60 minutes" -> 60)
            const durationText = durationEl?.textContent?.trim() || '';
            const durationMatch = durationText.match(/(\d+)/);
            const duration = durationMatch ? parseInt(durationMatch[1], 10) : 60;

            // Parse price (e.g., "$150.00" -> 15000 cents)
            const priceText = priceEl?.textContent?.trim() || '';
            const priceMatch = priceText.match(/\$?([\d,.]+)/);
            const price = priceMatch ? Math.round(parseFloat(priceMatch[1].replace(',', '')) * 100) : 0;

            results.push({
              id,
              name: nameEl.textContent?.trim() || 'Unknown Service',
              description: descEl?.textContent?.trim() || '',
              duration,
              price,
              category: undefined,
              href,
            });
          }
        });

        // Pattern 2: Category-based layout
        if (results.length === 0) {
          const categories = document.querySelectorAll('.category-group, .appointment-category');
          categories.forEach((category) => {
            const categoryName = category.querySelector('.category-name, h2')?.textContent?.trim();
            const items = category.querySelectorAll('.appointment-type, .type-item');

            items.forEach((item) => {
              const link = item.querySelector('a');
              const nameEl = item.querySelector('.name, .title');
              const descEl = item.querySelector('.description');
              const durationEl = item.querySelector('.duration');
              const priceEl = item.querySelector('.price');

              if (nameEl) {
                const href = link?.getAttribute('href') || '';
                const idMatch = href.match(/appointmentType=(\d+)/);
                const id = idMatch ? idMatch[1] : `generated-${Date.now()}-${Math.random().toString(36).slice(2)}`;

                const durationText = durationEl?.textContent?.trim() || '';
                const durationMatch = durationText.match(/(\d+)/);
                const duration = durationMatch ? parseInt(durationMatch[1], 10) : 60;

                const priceText = priceEl?.textContent?.trim() || '';
                const priceMatch = priceText.match(/\$?([\d,.]+)/);
                const price = priceMatch ? Math.round(parseFloat(priceMatch[1].replace(',', '')) * 100) : 0;

                results.push({
                  id,
                  name: nameEl.textContent?.trim() || 'Unknown Service',
                  description: descEl?.textContent?.trim() || '',
                  duration,
                  price,
                  category: categoryName,
                  href,
                });
              }
            });
          });
        }

        return results;
      });

      await page.close();
      return E.right(services);
    } catch (error) {
      if (page) await page.close().catch(() => {});

      if (error instanceof Error) {
        if (error.message.includes('net::') || error.message.includes('timeout')) {
          return E.left(
            Errors.infrastructure('NETWORK', `Failed to load Acuity page: ${error.message}`, error)
          );
        }
        return E.left(
          Errors.acuity('SCRAPE_FAILED', `Failed to scrape services: ${error.message}`)
        );
      }

      return E.left(
        Errors.acuity('SCRAPE_FAILED', 'Unknown error during scraping')
      );
    }
  }

  /**
   * Extract available dates for a specific service
   */
  async scrapeAvailableDates(
    serviceId: string,
    month?: string
  ): Promise<Either<AcuityError | InfrastructureError, string[]>> {
    let page: Page | null = null;

    try {
      page = await this.createPage();

      // Navigate to service-specific page. calendarID=any skips the
      // multi-practitioner "Select Calendar" interstitial (TIN-3113);
      // single-calendar types ignore it.
      const url = new URL(this.config.baseUrl);
      url.searchParams.set('appointmentType', serviceId);
      url.searchParams.set('calendarID', 'any');
      if (month) {
        // Format: YYYY-MM
        url.searchParams.set('month', month);
      }

      await page.goto(url.toString(), { waitUntil: 'networkidle' });

      // Wait for calendar to load
      await page.waitForSelector('.scheduleday, .calendar-day, [data-date]', {
        timeout: 10000,
      }).catch(() => {});

      const dates = await page.evaluate(() => {
        const results: string[] = [];

        // Pattern 1: scheduleday with activeday class
        const activeDays = document.querySelectorAll('.scheduleday.activeday, .calendar-day.available');
        activeDays.forEach((day) => {
          const date = day.getAttribute('data-date');
          if (date) {
            results.push(date);
          }
        });

        // Pattern 2: data-available attribute
        if (results.length === 0) {
          const availableDays = document.querySelectorAll('[data-available="true"], [data-has-slots="true"]');
          availableDays.forEach((day) => {
            const date = day.getAttribute('data-date');
            if (date) {
              results.push(date);
            }
          });
        }

        return results;
      });

      await page.close();
      return E.right(dates);
    } catch (error) {
      if (page) await page.close().catch(() => {});

      if (error instanceof Error) {
        return E.left(
          Errors.acuity('SCRAPE_FAILED', `Failed to scrape available dates: ${error.message}`)
        );
      }

      return E.left(
        Errors.acuity('SCRAPE_FAILED', 'Unknown error during date scraping')
      );
    }
  }

  /**
   * Extract available time slots for a specific date
   */
  async scrapeTimeSlots(
    serviceId: string,
    date: string
  ): Promise<Either<AcuityError | InfrastructureError, ScrapedTimeSlot[]>> {
    let page: Page | null = null;

    try {
      page = await this.createPage();

      // Navigate to service page. calendarID=any skips the
      // multi-practitioner "Select Calendar" interstitial (TIN-3113).
      const url = new URL(this.config.baseUrl);
      url.searchParams.set('appointmentType', serviceId);
      url.searchParams.set('calendarID', 'any');

      await page.goto(url.toString(), { waitUntil: 'networkidle' });

      // Wait for calendar and click the date
      await page.waitForSelector('.scheduleday, .calendar-day', { timeout: 10000 }).catch(() => {});

      // Click the specific date
      const dateSelector = `[data-date="${date}"], .scheduleday[data-date="${date}"]`;
      await page.click(dateSelector).catch(() => {
        // Date might not be clickable or use different mechanism
      });

      // Wait for time slots to load
      await page.waitForSelector('.time-selection, .time-slot, [data-time]', {
        timeout: 10000,
      }).catch(() => {});

      const slots = await page.evaluate(() => {
        const results: ScrapedTimeSlot[] = [];

        // Pattern 1: time-selection buttons
        const timeButtons = document.querySelectorAll('.time-selection button, .time-slot');
        timeButtons.forEach((btn) => {
          const timeText = btn.textContent?.trim() || '';
          const datetime = btn.getAttribute('data-time') || btn.getAttribute('data-datetime') || '';
          const isDisabled = btn.hasAttribute('disabled') || btn.classList.contains('disabled');

          if (timeText || datetime) {
            results.push({
              time: timeText,
              datetime,
              available: !isDisabled,
            });
          }
        });

        // Pattern 2: list items with time data
        if (results.length === 0) {
          const timeItems = document.querySelectorAll('[data-time], .available-time');
          timeItems.forEach((item) => {
            const timeText = item.textContent?.trim() || '';
            const datetime = item.getAttribute('data-time') || '';

            results.push({
              time: timeText,
              datetime,
              available: true,
            });
          });
        }

        return results;
      });

      await page.close();
      return E.right(slots);
    } catch (error) {
      if (page) await page.close().catch(() => {});

      if (error instanceof Error) {
        return E.left(
          Errors.acuity('SCRAPE_FAILED', `Failed to scrape time slots: ${error.message}`)
        );
      }

      return E.left(
        Errors.acuity('SCRAPE_FAILED', 'Unknown error during time slot scraping')
      );
    }
  }
}

// =============================================================================
// TASK EITHER WRAPPERS
// =============================================================================

/**
 * Create a scraper instance with Effect wrapper
 *
 * @deprecated Use extract-business.ts for services and wizard steps for availability/slots.
 */
export const createScraperAdapter = (config: ScraperConfig) => {
  const scraper = new AcuityScraper(config);

  /** Convert the scraper's Promise<Either<E, A>> to Effect<A, E> */
  const fromScraper = <E2, A>(
    fn: () => Promise<Either<E2, A>>,
    label: string,
  ): Effect.Effect<A, AcuityError | InfrastructureError> =>
    Effect.flatMap(
      Effect.tryPromise({
        try: fn,
        catch: (error) => Errors.acuity('SCRAPE_FAILED', error instanceof Error ? error.message : `${label} failed`),
      }),
      (result) =>
        E.isLeft(result)
          ? Effect.fail(result.left as AcuityError | InfrastructureError)
          : Effect.succeed(result.right),
    );

  return {
    /**
     * Get all services
     * @deprecated Always returns [] on Acuity's React SPA.
     */
    getServices: (): SchedulingResult<Service[]> =>
      Effect.map(
        fromScraper(() => scraper.scrapeServices(), 'scrapeServices'),
        (scraped) =>
          scraped.map(
            (s): Service => ({
              id: s.id,
              name: s.name,
              description: s.description,
              duration: s.duration,
              price: s.price,
              currency: 'USD',
              category: s.category,
              active: true,
            })
          )
      ),

    /**
     * Get available dates for a service
     * @deprecated Use readAvailableDates() from middleware/steps/.
     */
    getAvailableDates: (
      serviceId: string,
      month?: string
    ): SchedulingResult<string[]> =>
      fromScraper(() => scraper.scrapeAvailableDates(serviceId, month), 'scrapeAvailableDates'),

    /**
     * Get available time slots for a date
     * @deprecated Use readTimeSlots() from middleware/steps/.
     */
    getTimeSlots: (
      serviceId: string,
      date: string
    ): SchedulingResult<TimeSlot[]> =>
      Effect.map(
        fromScraper(() => scraper.scrapeTimeSlots(serviceId, date), 'scrapeTimeSlots'),
        (slots) =>
          slots
            .filter((s) => s.available)
            .map(
              (s): TimeSlot => ({
                datetime: s.datetime || `${date}T${s.time}`,
                available: s.available,
              })
            )
      ),

    /**
     * Initialize browser
     */
    init: () => scraper.init(),

    /**
     * Close browser
     */
    close: () => scraper.close(),

    /**
     * Get the underlying scraper instance
     */
    getScraper: () => scraper,
  };
};

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * One-shot scrape of all services (opens and closes browser)
 * @deprecated Use fetchBusinessData() from extract-business.ts
 */
export const scrapeServicesOnce = (
  baseUrl: string
): SchedulingResult<Service[]> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => { const a = createScraperAdapter({ baseUrl }); await a.init(); return a; },
      catch: (e) => Errors.infrastructure('UNKNOWN', e instanceof Error ? e.message : 'Failed to init scraper'),
    }),
    (adapter) => adapter.getServices(),
    (adapter) => Effect.promise(() => adapter.close()),
  );

/**
 * One-shot scrape of availability (opens and closes browser)
 * @deprecated Use readTimeSlots() from middleware/steps/
 */
export const scrapeAvailabilityOnce = (
  baseUrl: string,
  serviceId: string,
  date: string
): SchedulingResult<TimeSlot[]> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => { const a = createScraperAdapter({ baseUrl }); await a.init(); return a; },
      catch: (e) => Errors.infrastructure('UNKNOWN', e instanceof Error ? e.message : 'Failed to init scraper'),
    }),
    (adapter) => adapter.getTimeSlots(serviceId, date),
    (adapter) => Effect.promise(() => adapter.close()),
  );
