const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const axios = require('axios');

const app = express();
// Increase limit for potentially large reports with embedded images
app.use(express.json({ limit: '50mb' }));
app.use(cors()); // Enable CORS for all routes

const PORT = process.env.PORT || 8080;

/**
 * Fetches an image from a URL and converts it to a base64 data URL.
 * @param {string | null} url The URL of the image to fetch.
 * @returns {Promise<string | null>} A promise that resolves to the data URL or null.
 */
async function imageUrlToDataUrl(url) {
    if (!url || !url.startsWith('http')) {
        console.warn(`Invalid or missing URL provided: ${url}`);
        return null;
    }
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 }); // 10s timeout
        const mimeType = response.headers['content-type'];
        if (!mimeType || !mimeType.startsWith('image/')) {
            console.warn(`URL did not point to a valid image: ${url}`);
            return null;
        }
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        return `data:${mimeType};base64,${base64}`;
    } catch (error) {
        // Log a warning but don't crash the process. The PDF will just have a missing image.
        console.warn(`Could not fetch image at ${url}:`, error.message);
        return null; 
    }
}


app.get('/', (req, res) => {
  res.send('APEX PDF Generator is running.');
});

app.post('/generate-pdf', async (req, res) => {
    console.log("Received request to generate PDF.");
    const { finalReport, clientInfo, competitorData, clientUrl } = req.body;

    if (!finalReport || !clientInfo || !competitorData || !clientUrl) {
        return res.status(400).send({ error: 'Missing required report data.' });
    }

    let browser = null;
    try {
        console.log("Processing images for PDF embedding...");
        const competitorDataWithImages = await Promise.all(competitorData.map(async (comp) => ({
            ...comp,
            logoDataUrl: await imageUrlToDataUrl(comp.logoUrl),
            creativeDataUrl: await imageUrlToDataUrl(comp.creativeUrl),
        })));
        
        console.log("Launching Puppeteer...");
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            timeout: 60000, 
        });

        console.log("Puppeteer launched. Opening new page.");
        const page = await browser.newPage();

        console.log("Generating HTML content.");
        const htmlContent = getFullReportHtml(finalReport, clientInfo, competitorDataWithImages, clientUrl);
        
        console.log("Setting page content.");
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 60000 });

        console.log("Generating PDF from page content.");
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
        });

        console.log("PDF generated successfully. Sending response.");
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="apex-report-${new Date().toISOString().split('T')[0]}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Failed to generate PDF:', error);
        res.status(500).send({ error: 'An error occurred while generating the PDF.', details: error.message });
    } finally {
        if (browser) {
            console.log("Closing browser.");
            await browser.close();
        }
    }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// --- HTML Generation Logic ---

const svgs = {
    checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #22c55e; flex-shrink: 0; margin-top: 0.125rem; display: inline-block; vertical-align: middle;"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path><path d="m9 12 2 2 4-4"></path></svg>`,
    xCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #ef4444; flex-shrink: 0; margin-top: 0.125rem; display: inline-block; vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg>`,
};

const getAnalysisContentHtml = (content) => {
    let html = '<ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem;">';
    const points = content || { good: [], bad: [] };
    if (!points.good?.length && !points.bad?.length) {
        return '<li style="color: #a3a3a3; font-style: italic;">No specific points provided.</li>';
    }
    points.good?.forEach(point => {
        html += `<li style="display: flex; align-items: flex-start; gap: 0.5rem;">${svgs.checkCircle}<span style="color: #d4d4d4;">${point}</span></li>`;
    });
    points.bad?.forEach(point => {
        html += `<li style="display: flex; align-items: flex-start; gap: 0.5rem;">${svgs.xCircle}<span style="color: #d4d4d4;">${point}</span></li>`;
    });
    html += '</ul>';
    return html;
};

const getDealItemHtml = (deal) => {
    const originalPrice = deal.originalPrice ? `$${deal.originalPrice.toFixed(2)}` : '';
    const salePrice = deal.salePrice ? `$${deal.salePrice.toFixed(2)}` : '';
    const percent = deal.percentDiscount && deal.percentDiscount > 0 ? `<span style="background-color:#991b1b; color:#fecaca; font-size: 0.75rem; font-weight: 700; padding: 0.125rem 0.5rem; border-radius: 9999px; margin-left: 0.5rem;">${deal.percentDiscount}% OFF</span>` : '';
    return `
        <li style="border-bottom: 1px solid #2d2d2d; padding-bottom: 0.75rem; margin-bottom: 0.75rem;">
            <p style="color:#a78bfa;">${deal.name}</p>
            <div style="color:#d4d4d4; margin-top: 0.25rem; display: flex; align-items: center;">
                <span style="font-size: 1.125rem; font-weight: 700; color: #f87171;">${salePrice}</span>
                ${originalPrice ? `<span style="font-size: 0.875rem; text-decoration: line-through; color: #525252; margin-left: 0.5rem;">${originalPrice}</span>` : ''}
                ${percent}
            </div>
        </li>`;
};

const getDealThermometerHtml = (dealRating) => {
    let barClass = 'frosty';
    if (dealRating === 'luke-warm') barClass = 'luke-warm';
    if (dealRating === 'hot') barClass = 'hot';
    if (dealRating === 'pipin-hot') barClass = 'pipin-hot';

    const barStyle = {
        frosty: "width: 20%; background-image: linear-gradient(to right, #3b82f6, #60a5fa);",
        'luke-warm': "width: 45%; background-image: linear-gradient(to right, #3b82f6, #facc15);",
        hot: "width: 70%; background-image: linear-gradient(to right, #f59e0b, #ef4444);",
        'pipin-hot': "width: 95%; background-image: linear-gradient(to right, #ef4444, #dc2626, #b91c1c);",
    }[barClass];

    return `<div style="width: 100%; height: 1rem; background-color: #2d2d2d; border-radius: 9999px; overflow: hidden;"><div style="height: 100%; border-radius: 9999px; ${barStyle}"></div></div>`;
};

const getSingleCompetitorCardHtml = (competitor, report) => `
    <div style="background-color: #1e1e1e; border-radius: 1rem; border: 1px solid #2d2d2d; overflow: hidden; margin-bottom: 1.5rem; break-inside: avoid;">
        <div style="display: flex; align-items: center; gap: 1rem; padding: 1.5rem; border-bottom: 1px solid #2d2d2d;">
            ${competitor.logoDataUrl ? `<img src="${competitor.logoDataUrl}" alt="${competitor.name} Logo" style="width: 4rem; height: 4rem; border-radius: 9999px; object-fit: contain; border: 1px solid #404040; background-color: white; padding: 0.25rem;" />` : `<div style="width: 4rem; height: 4rem; border-radius: 9999px; background-color: #2d2d2d; display:flex; align-items:center; justify-content:center; color: #a3a3a3; font-size:0.75rem; text-align:center;">No Logo</div>`}
            <div>
                <h3 style="font-size: 1.5rem; font-weight: 700; color: white;">${competitor.name}</h3>
                <p style="color:#a78bfa; font-size: 0.875rem; word-break: break-all;">${competitor.url}</p>
            </div>
        </div>
        <div style="padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem;">
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem;">
                <div><h4 style="font-size: 0.875rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; margin-bottom: 0.5rem;">Deal Type</h4><p style="font-size: 1rem; color: #e5e5e5;">${competitor.dealType || 'N/A'}</p></div>
                <div><h4 style="font-size: 0.875rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; margin-bottom: 0.5rem;">Duration</h4><p style="font-size: 1rem; color: #e5e5e5;">${competitor.dealDuration || 'N/A'}</p></div>
            </div>
            <div><h4 style="font-size: 0.875rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; margin-bottom: 0.5rem;">Deal-o-Meter</h4>${getDealThermometerHtml(report.dealRating)}</div>
            <div><h4 style="font-size: 0.875rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; margin-bottom: 0.75rem;">How You Compare</h4>${getAnalysisContentHtml(report.analysis)}</div>
            <div><h4 style="font-size: 0.875rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; margin-bottom: 0.75rem;">Top Deals</h4><ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem;">${competitor.topDeals && competitor.topDeals.length > 0 ? competitor.topDeals.map(getDealItemHtml).join('') : '<p style="color:#a3a3a3;">No top deals found.</p>'}</ul></div>
            ${competitor.creativeDataUrl ? `<div style="padding-top: 1.5rem;"><h4 style="font-size: 0.875rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; margin-bottom: 0.75rem;">Ad Creative</h4><img src="${competitor.creativeDataUrl}" alt="${competitor.name} Ad Creative" style="width: 100%; border-radius: 0.5rem; object-fit: contain; border: 1px solid #2d2d2d;" /></div>` : ''}
        </div>
    </div>`;

const getFullReportHtml = (finalReport, clientInfo, competitorDataWithImages, clientUrl) => {
    const { recommendation } = finalReport;
    const { numericScore, rating } = recommendation;
    let ratingColorClasses = 'background-color:#404040; color:#d4d4d4;';
    if (numericScore <= 3) ratingColorClasses = 'background-color:rgba(127, 29, 29, 0.5); color:#fca5a5;';
    else if (numericScore <= 6) ratingColorClasses = 'background-color:rgba(113, 63, 18, 0.5); color:#fcd34d;';
    else if (numericScore <= 8) ratingColorClasses = 'background-color:rgba(76, 29, 149, 0.5); color:#c4b5fd;';
    else ratingColorClasses = 'background-color:rgba(20, 83, 45, 0.5); color:#86efac;';
    let clientName = 'Deal Scorecard';
    try { clientName = `Deal Scorecard: ${new URL(clientUrl).hostname.replace(/^www\./, '')}`; } catch(e) {}

    return `
        <html>
            <head>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap');
                    body {
                        background-color: #121212;
                        color: #e5e5e5;
                        font-family: 'Lexend', sans-serif;
                    }
                </style>
            </head>
            <body>
                <div style="width: 800px; margin: auto; padding: 40px;">
                    <header style="text-align:center; margin-bottom:2rem;">
                        <h1 style="font-size:2.25rem; font-weight:700; color:#a78bfa; margin-bottom:0.5rem;">APEX Report</h1>
                        <p style="font-size:1.125rem; color:#a3a3a3;">Client: ${clientUrl}</p>
                    </header>

                    <div style="background-color:#1e1e1e; padding: 2rem; border-radius:1rem; border:1px solid #2d2d2d; margin-bottom: 2rem;">
                        <h2 style="font-size:1.5rem; color:white; font-weight:700; margin-bottom:1rem;">Competitor Summary</h2>
                        <p style="color:#a3a3a3; margin-bottom:1rem;">Analysis based on <strong style="color:#a78bfa;">${competitorDataWithImages.length}</strong> relevant competitors.</p>
                        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                            ${competitorDataWithImages.map(c => `<span style="background-color:#2d2d2d; color:#e5e5e5; font-size:0.875rem; padding:0.25rem 0.75rem; border-radius:9999px;">${c.name}</span>`).join('')}
                        </div>
                    </div>
            
                    <div style="background-color:#1e1e1e; padding:2rem; border-radius:1rem; border:1px solid #2d2d2d; box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.3); margin-bottom: 2rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                            <h2 style="font-size:1.875rem; color:white; font-weight:700;">${clientName}</h2>
                            <span style="font-size:1.125rem; font-weight:700; padding:0.5rem 1rem; border-radius:9999px; ${ratingColorClasses}">${numericScore}/10: ${rating.toUpperCase()}</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
                            <div>
                                <h4 style="font-size:1.25rem; color:white; font-weight:600; margin-bottom:0.5rem;">Summary</h4>
                                <p style="color:#d4d4d4;">${recommendation.summary}</p>
                            </div>
                            ${['Discounts', 'Messaging', 'Competitiveness'].map(title => `
                            <div>
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                                    <h4 style="font-size:1.25rem; color:white; font-weight:600;">${title}</h4>
                                    <span style="background-color:#2d2d2d; color:#a3a3a3; padding:0.25rem 0.75rem; border-radius:9999px;">${recommendation[(title.toLowerCase() + 'Score')]} / 10</span>
                                </div>
                                ${getAnalysisContentHtml(recommendation[title.toLowerCase()])}
                            </div>
                            `).join('')}
                        </div>
                    </div>
            
                    <div>
                        <h2 style="font-size:1.875rem; color:white; font-weight:700; margin-bottom:1.5rem; padding-top: 2rem; border-top: 1px solid #2d2d2d;">Competitor Teardown</h2>
                        <div>
                            ${competitorDataWithImages.map(comp => {
                                const report = finalReport.comparison.find(c => c.competitorName === comp.name);
                                return report ? getSingleCompetitorCardHtml(comp, report) : '';
                            }).join('')}
                        </div>
                    </div>
                </div>
            </body>
        </html>
    `;
};
