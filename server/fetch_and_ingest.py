#!/usr/bin/env python3
"""
fetch_and_ingest.py
Triggers the Apify scraper actor, polls for its status until completion,
downloads the scraped tender dataset, and ingests it into the PostgreSQL database.
No external dependencies required (uses only standard library modules).

Usage:
  python3 server/fetch_and_ingest.py
"""

import os
import sys
import json
import time
import ssl
import urllib.request
import urllib.error
import subprocess
import argparse
from pathlib import Path

# Create an unverified SSL context to resolve certificate verification issues on macOS
ssl_context = ssl._create_unverified_context()

def load_env(env_path):
    """Parses a simple .env file manually to avoid dependency on python-dotenv."""
    env_vars = {}
    if not env_path.exists():
        return env_vars
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            env_vars[key.strip()] = val.strip().strip('"').strip("'")
    return env_vars

def main():
    print("🚀 Starting Qatar Tenders Data Acquisition & Ingestion Pipeline...")
    
    # 1. Load configuration
    project_root = Path(__file__).resolve().parent.parent
    env_path = project_root / ".env"
    env = load_env(env_path)
    
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Trigger Apify crawler actor and ingest results.")
    parser.add_argument("--token", help="Apify API Token (overrides .env)")
    parser.add_argument("--actor-id", help="Apify Actor ID (overrides .env)")
    parser.add_argument("--start-url", help="Start URL to crawl (can be relative path like /TendersOnlineServices/AwardedTenders/41)")
    parser.add_argument("--max-requests", type=int, default=1500, help="Maximum requests per crawl (default: 1500)")
    parser.add_argument("--only-awarded", action="store_true", help="Only crawl awarded tenders")
    parser.add_argument("--only-available", action="store_true", help="Only crawl available tenders")
    parser.add_argument("--start-page", type=int, help="Start page for pagination (default: 1)")
    args = parser.parse_args()
    
    token = args.token or env.get("APIFY_TOKEN") or os.environ.get("APIFY_TOKEN")
    actor_id = args.actor_id or env.get("APIFY_ACTOR_ID") or os.environ.get("APIFY_ACTOR_ID")
    db_url = env.get("DATABASE_URL") or os.environ.get("DATABASE_URL")
    
    if not token or not actor_id:
        print("❌ Error: APIFY_TOKEN and APIFY_ACTOR_ID must be set in .env, environment variables, or via CLI flags.")
        sys.exit(1)
        
    print(f"🔗 Apify Actor ID: {actor_id}")
    print(f"🔗 Database Host: {db_url.split('@')[-1].split('/')[0] if db_url else 'Not Set'}")

    # 2. Trigger the Actor
    trigger_url = f"https://api.apify.com/v2/acts/{actor_id}/runs?token={token}"
    print("\n⚡ Triggering Apify crawler actor run...")
    
    payload = {
        "useApifyProxy": True,
        "apifyProxyGroups": ["RESIDENTIAL"],
        "apifyProxyCountryCode": "QA",
        "maxConcurrency": 1,
        "maxRequestsPerCrawl": args.max_requests
    }
    
    if args.start_url:
        start_url_full = args.start_url
        if start_url_full.startswith("/"):
            start_url_full = f"https://monaqasat.mof.gov.qa{start_url_full}"
        payload["startUrls"] = [{"url": start_url_full}]
        
    if args.start_page:
        payload["startPage"] = args.start_page
    if args.only_awarded:
        payload["onlyAwarded"] = True
    if args.only_available:
        payload["onlyAvailable"] = True
        
    req = urllib.request.Request(
        trigger_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, context=ssl_context) as res:
            res_data = json.loads(res.read().decode("utf-8"))
            run_data = res_data.get("data", {})
            run_id = run_data.get("id")
            dataset_id = run_data.get("defaultDatasetId")
            status = run_data.get("status")
            print(f"✅ Actor triggered successfully!")
            print(f"   • Run ID: {run_id}")
            print(f"   • Dataset ID: {dataset_id}")
            print(f"   • Initial Status: {status}")
    except urllib.error.URLError as e:
        print(f"❌ Failed to trigger actor: {e}")
        if hasattr(e, "read"):
            print(e.read().decode("utf-8"))
        sys.exit(1)

    # 3. Poll for run status
    status_url = f"https://api.apify.com/v2/actor-runs/{run_id}?token={token}"
    start_time = time.time()
    print("\n⏳ Polling crawler progress...")
    
    active_statuses = {"READY", "RUNNING"}
    consecutive_errors = 0
    
    while True:
        try:
            with urllib.request.urlopen(status_url, context=ssl_context) as res:
                run_status_data = json.loads(res.read().decode("utf-8")).get("data", {})
                current_status = run_status_data.get("status")
                item_count = run_status_data.get("stats", {}).get("outputItemCount", 0)
                elapsed = int(time.time() - start_time)
                
                # Format elapsed time as MM:SS
                mins, secs = divmod(elapsed, 60)
                time_str = f"{mins:02d}:{secs:02d}"
                
                print(f"   [{time_str}] Status: {current_status:10} | Items collected: {item_count}", end="\r")
                
                if current_status not in active_statuses:
                    print(f"\n🏁 Crawl finished with final status: {current_status}")
                    final_run_data = run_status_data
                    break
                    
            consecutive_errors = 0
        except Exception as e:
            consecutive_errors += 1
            print(f"\n⚠️ Polling error ({consecutive_errors}/5): {e}")
            if consecutive_errors >= 5:
                print("❌ Aborting due to repeated polling failures.")
                sys.exit(1)
        
        time.sleep(10)

    # 4. Ingest if succeeded
    if final_run_data.get("status") == "SUCCEEDED":
        print(f"\n⬇️ Fetching items from dataset {dataset_id}...")
        dataset_url = f"https://api.apify.com/v2/datasets/{dataset_id}/items?clean=true&format=json&token={token}"
        
        try:
            with urllib.request.urlopen(dataset_url, context=ssl_context) as res:
                items = json.loads(res.read().decode("utf-8"))
                print(f"✅ Fetched {len(items)} records from Apify.")
        except Exception as e:
            print(f"❌ Failed to download dataset: {e}")
            sys.exit(1)
            
        # Ensure data folder exists
        data_dir = project_root / "data"
        data_dir.mkdir(exist_ok=True)
        
        temp_file = data_dir / "temp_import.json"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(items, f)
            
        # 5. Run local Node ingestion script
        print(f"\n📥 Running Node ingestion database script...")
        node_script = project_root / "server" / "ingest.js"
        
        env_vars = os.environ.copy()
        if db_url:
            env_vars["DATABASE_URL"] = db_url
            
        try:
            res = subprocess.run(
                ["node", str(node_script), str(temp_file)],
                capture_output=True,
                text=True,
                env=env_vars,
                check=True
            )
            print("\n📊 Ingestion Output Summary:")
            print(res.stdout)
        except subprocess.CalledProcessError as e:
            print("❌ Node Ingestion failed with error code:", e.returncode)
            print("Stderr:", e.stderr)
            print("Stdout:", e.stdout)
        finally:
            if temp_file.exists():
                temp_file.unlink()
                print("🗑️ Cleaned up temporary JSON download file.")
    else:
        print(f"❌ Scraper did not succeed. Skipping database ingestion. Run Details: {final_run_data.get('status')}")
        sys.exit(1)

    print("\n✨ Pipeline completed successfully!")

if __name__ == "__main__":
    main()
