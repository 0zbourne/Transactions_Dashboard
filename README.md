<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# Transactions Dashboard

**A unified, intelligent dashboard for managing your bank transactions.**
Auto-categorize transactions, detect recurring subscriptions, and uncover AI-driven insights to save money natively in your browser.

</div>

## Features

- **Unified View:** Combine transactions from multiple sources (Barclaycard, Amex, and Starling) into a single, cohesive timeline.
- **Smart Categorization:** Advanced local heuristics and keyword matching intelligently tag transactions into categories like *Income, Groceries, Transfer, Transport*, and more.
- **Subscription Tracker:** Automatically detects your recurring payments, identifies frequencies (Weekly, Monthly, Yearly), and calculates exact annual costs.
- **Savings Insights:** Generates actionable financial insights, such as high dining-out spend warnings or streaming service consolidation opportunities.
- **Privacy First:** Data is parsed directly in your browser.

## Getting Started

Follow these steps to run the dashboard locally:

### Prerequisites

- Node.js (v18 or higher recommended)
- The raw CSV exports from your supported banking providers.

### Installation

1. **Clone the repository** (if you haven't already):
   ```bash
   git clone https://github.com/0zbourne/Transactions_Dashboard.git
   cd Transactions_Dashboard
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Environment Setup**:
   Copy the `.env.example` file to create your local environment configurator.
   ```bash
   cp .env.example .env.local
   ```
   Add your `GEMINI_API_KEY` (if you are testing the AI feature).

4. **Run the development server**:
   ```bash
   npm run dev
   ```

5. **Open the App:** Navigate to `http://localhost:3000` in your web browser. 

## Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS, Motion (Framer Motion)
- **Data Visualizations:** Chart.js with react-chartjs-2
- **Data Parsing:** PapaParse for handling dirty CSV extracts natively.
- **AI Integration:** Google GenAI SDK for generating smart financial recommendations.
- **Build Tool:** Vite

## Note on Screenshots

*(I attempted to automatically capture a video walkthrough of the UI running locally for you, but encountered a rate-limiting quota error on my browser tool. Once the quota resets, you can simply run the app locally to capture the UI screenshots and embed them here!)*
