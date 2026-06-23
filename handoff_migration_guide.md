# Handoff & Migration Guide: Qatar Tender Tracker

This guide outlines the steps to migrate the **Qatar Tender Tracker** project and your **Gemini Antigravity** conversation history to your new MacBook.

---

## 1. Project Code (GitHub)

All code modifications and the database backup file have been committed and pushed to your remote repository.

On your new MacBook, run:
```bash
git clone https://github.com/Rakif215/qatar-tender-tracker.git
cd qatar-tender-tracker
npm install
```

---

## 2. Environment Variables (`.env`)

Create a `.env` file in the root of the project directory on your new MacBook and paste the following configuration:

```env
DATABASE_URL=postgres://rakifkhan@localhost:5432/qatar_tenders
PORT=3001
APIFY_TOKEN=YOUR_APIFY_TOKEN_HERE
APIFY_ACTOR_ID=BhA7CC6P6tGjsI6it
GITHUB_TOKEN=YOUR_GITHUB_TOKEN_HERE
```

*Note: Replace `YOUR_APIFY_TOKEN_HERE` and `YOUR_GITHUB_TOKEN_HERE` with the values from your current laptop's `.env` file.*

---

## 3. Database Migration

A complete database backup file containing **773 tenders, 1,228 bids, and 551 companies** has been saved to the repository at `db/qatar_tenders_backup.sql`.

On your new MacBook:
1. Ensure PostgreSQL is installed and running (e.g., using `brew install postgresql@14`).
2. Create the target database:
   ```bash
   createdb qatar_tenders
   ```
   *(Or if you use psql: `psql -c "CREATE DATABASE qatar_tenders;"`)*
3. Restore the backup:
   ```bash
   psql -d qatar_tenders -f db/qatar_tenders_backup.sql
   ```

---

## 4. Chat History & Workspace Migration (Gemini Antigravity)

To keep this exact conversation, agent state, and active workspace logs:

1. Locate the Gemini Antigravity App Data directory on your current MacBook:
   * **Path:** `/Users/falakpathan/.gemini/antigravity`
2. Compress or copy this folder:
   ```bash
   tar -czf ~/Desktop/gemini_antigravity_backup.tar.gz -C /Users/falakpathan/.gemini antigravity
   ```
3. Transfer the `gemini_antigravity_backup.tar.gz` file to your new MacBook.
4. On your new MacBook, extract it into the same location:
   * **Path:** `~/.gemini/antigravity`
   ```bash
   mkdir -p ~/.gemini
   tar -xzf gemini_antigravity_backup.tar.gz -C ~/.gemini
   ```

When you launch Gemini Antigravity on your new MacBook, it will read from this directory and restore the chat session, conversation files, and tools.

---

## 5. Next Steps for Dashboard & Graphs (To Resume Tomorrow)

When we resume tomorrow, here is our plan to address your feedback regarding the graphs and RAG/Knowledge Graph:

1. **Clean Up Fake Metrics**:
   * Completely remove the static "38% confidence" score from the bidder prediction.
   * Shift the UI to display **fact-based metrics** (e.g., "Company A has bid on X tenders with Entity Y in Sector Z, winning N times").
2. **Improve Matching Logic**:
   * Instead of simple title-matching, we will query bids by category ID, sector, and buyer entity overlap to get accurate historic matches.
3. **Knowledge Graph & RAG Implementation**:
   * We will build a backend knowledge graph structure connecting Tenders, Entities (Buyers), Categories, and Companies.
   * We can implement a RAG pipeline utilizing the Gemini API to let you query the database with natural language (e.g., *"Summarize HMC's top medical suppliers and their win rates"*).
