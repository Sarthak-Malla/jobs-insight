import puppeteer from "puppeteer";
import Job from "../models/job.js";

/**
 * Scrape early career job listings from LinkedIn
 * @param {Object} options - Scraping options
 * @param {string} options.location - Job location (e.g., 'United States')
 * @param {number} options.pages - Number of pages to scrape
 * @returns {Promise<Array>} - Array of scraped job data
 */
export async function scrapeLinkedInJobs({ location = "", pages = 3 } = {}) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    console.log("Starting LinkedIn scraper...");
    const page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36"
    );

    // Search parameters - focus on entry-level positions
    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=entry%20level&location=${encodeURIComponent(
      location
    )}&f_E=1%2C2&f_JT=F`;
    console.log(`Navigating to ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for job listings to load
    await page
      .waitForSelector(".jobs-search__results-list", { timeout: 10000 })
      .catch((e) => console.log("Selector timeout, proceeding anyway"));

    const jobListings = [];

    // Iterate through the specified number of pages
    for (let currentPage = 0; currentPage < pages; currentPage++) {
      console.log(`Scraping page ${currentPage + 1} of ${pages}`);

      // Extract job data from current page
      const pageJobs = await page.evaluate(() => {
        const jobs = [];
        const listings = document.querySelectorAll(
          ".jobs-search__results-list > li"
        );

        listings.forEach((listing) => {
          try {
            const titleElement = listing.querySelector(
              ".base-search-card__title"
            );
            const companyElement = listing.querySelector(
              ".base-search-card__subtitle"
            );
            const locationElement = listing.querySelector(
              ".job-search-card__location"
            );
            const linkElement = listing.querySelector("a");

            if (titleElement && companyElement && linkElement) {
              jobs.push({
                title: titleElement.textContent.trim(),
                company: companyElement.textContent.trim(),
                location: locationElement
                  ? locationElement.textContent.trim()
                  : "Remote/Unspecified",
                url: linkElement.href,
                source: "LinkedIn",
              });
            }
          } catch (error) {
            console.error("Error parsing job listing:", error);
          }
        });

        return jobs;
      });

      console.log(`Found ${pageJobs.length} jobs on page ${currentPage + 1}`);

      // Set the postedDate outside the evaluate function for each job
      pageJobs.forEach((job) => {
        job.postedDate = new Date(); // Set current date
      });

      jobListings.push(...pageJobs);

      // TODO: Scroll for more jobs
    }

    console.log(
      `LinkedIn scraping complete. Total jobs found: ${jobListings.length}`
    );
    return jobListings;
  } catch (error) {
    console.error("LinkedIn scraper error:", error);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Scrape job details from individual LinkedIn job pages
 * @param {string} url - URL of the job posting
 * @returns {Promise<Object>} - Object containing job details
 */
export async function scrapeLinkedInJobDetails(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for job details to load
    await page
      .waitForSelector(".decorated-job-posting__details", { timeout: 10000 })
      .catch((e) => console.log("Selector timeout, proceeding anyway"));

    // Extract detailed job information
    const jobDetails = await page.evaluate(() => {
      // Extract job description
      const descriptionElement = document.querySelector(".description__text");
      const description = descriptionElement
        ? descriptionElement.textContent.trim()
        : "";

      // Extract job details
      const criteriaElements = document.querySelectorAll(
        ".description__job-criteria-item"
      );
      let jobType = "Other";
      let salary = "";
      let experienceLevel = "Entry Level";

      criteriaElements.forEach((item) => {
        const label = item
          .querySelector(".description__job-criteria-subheader")
          ?.textContent.trim();
        const value = item
          .querySelector(".description__job-criteria-text")
          ?.textContent.trim();

        if (label?.includes("Employment type")) {
          jobType = value || "Other";
        } else if (
          label?.includes("Salary") ||
          label?.includes("Compensation")
        ) {
          salary = value || "";
        } else if (label?.includes("Experience level")) {
          experienceLevel = value || "Entry Level";
        }
      });

      // Extract skills (if available)
      const skillElements = document.querySelectorAll(
        ".job-details-skill-match-status-list > li"
      );
      const skills = Array.from(skillElements).map((skill) =>
        skill.textContent.trim()
      );

      return {
        description,
        jobType,
        salary,
        experienceLevel,
        skills,
      };
    });

    return jobDetails;
  } catch (error) {
    console.error("Error scraping LinkedIn job details:", error);
    return {
      description: "",
      jobType: "Other",
      salary: "",
      skills: [],
    };
  } finally {
    await browser.close();
  }
}

/**
 * Scrape LinkedIn jobs and save to database
 * @param {Object} options - Scraping options
 * @returns {Promise<number>} - Number of jobs saved
 */
export async function scrapeAndSaveLinkedInJobs(options = {}) {
  try {
    const jobs = await scrapeLinkedInJobs(options);
    const jobsWithDetails = [];
    let savedCount = 0;

    for (const job of jobs) {
      try {
        // Check if job already exists in database
        const existingJob = await Job.findOne({ url: job.url });

        if (!existingJob) {
          // Ensure postedDate is a valid Date object
          if (
            !job.postedDate ||
            !(job.postedDate instanceof Date) ||
            isNaN(job.postedDate)
          ) {
            job.postedDate = new Date(); // Set to current date if invalid
          }

          // Get additional job details including description
          console.log(
            `Fetching details for job: ${job.title} at ${job.company}`
          );
          const details = await scrapeLinkedInJobDetails(job.url);
          const enhancedJob = {
            ...job,
            ...details,
          };

          jobsWithDetails.push(enhancedJob);

          // Save the enhanced job with description to the database
          await Job.create(enhancedJob);
          console.log(`Saved job with description: ${job.title}`);
          savedCount++;
        }
      } catch (error) {
        console.error(`Error saving LinkedIn job (${job.title}):`, error);
      }
    }

    console.log(`LinkedIn scraper completed. Saved ${savedCount} new jobs.`);
    return jobsWithDetails;
  } catch (error) {
    console.error("LinkedIn scraper error:", error);
    return 0;
  }
}

export default {
  scrapeLinkedInJobs,
  scrapeLinkedInJobDetails,
  scrapeAndSaveLinkedInJobs,
};
