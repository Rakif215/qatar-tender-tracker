/**
 * server/categorize.js
 * Rule-based keyword classifier for tender titles.
 */

const CATEGORIES = [
  {
    slug: "pharma",
    name: "Pharmaceuticals & Drugs",
    color: "#EC4899", // pink
    icon: "Pills",
    keywords: [
      { term: "drugs", weight: 10 },
      { term: "pharmaceutical", weight: 10 },
      { term: "vaccine", weight: 10 },
      { term: "vaccines", weight: 10 },
      { term: "medication", weight: 10 },
      { term: "tablet", weight: 8 },
      { term: "tablets", weight: 8 },
      { term: "capsule", weight: 8 },
      { term: "injection", weight: 8 },
      { term: "injections", weight: 8 },
      { term: "generic", weight: 6 },
      { term: "medicine", weight: 8 },
      { term: "medicines", weight: 8 },
      { term: "pharma", weight: 8 },
      { term: "sartan", weight: 10 },
      { term: "insulin", weight: 10 },
      { term: "vials", weight: 7 }
    ]
  },
  {
    slug: "medical_supplies",
    name: "Medical Supplies & Consumables",
    color: "#06B6D4", // cyan
    icon: "Stethoscope",
    keywords: [
      { term: "medical consumables", weight: 10 },
      { term: "medical equipment", weight: 10 },
      { term: "surgical", weight: 9 },
      { term: "laboratory", weight: 8 },
      { term: "reagent", weight: 9 },
      { term: "reagents", weight: 9 },
      { term: "needles", weight: 8 },
      { term: "syringes", weight: 8 },
      { term: "gloves", weight: 8 },
      { term: "gowns", weight: 8 },
      { term: "gauze", weight: 8 },
      { term: "cardiac", weight: 8 },
      { term: "implant", weight: 8 },
      { term: "implants", weight: 8 },
      { term: "stent", weight: 9 },
      { term: "dialysis", weight: 9 },
      { term: "orthopedic", weight: 9 },
      { term: "dressings", weight: 8 },
      { term: "disposables", weight: 6 },
      { term: "hospital furniture", weight: 9 },
      { term: "diagnostic", weight: 7 }
    ]
  },
  {
    slug: "it_tech",
    name: "IT & Technology",
    color: "#3B82F6", // blue
    icon: "Laptop",
    keywords: [
      { term: "software", weight: 10 },
      { term: "system", weight: 3 }, // low weight because it's generic, but combined with others it helps
      { term: "network", weight: 8 },
      { term: "license", weight: 8 },
      { term: "licenses", weight: 8 },
      { term: "server", weight: 9 },
      { term: "servers", weight: 9 },
      { term: "cybersecurity", weight: 10 },
      { term: "database", weight: 9 },
      { term: "digital", weight: 8 },
      { term: "hardware", weight: 9 },
      { term: "computers", weight: 9 },
      { term: "laptops", weight: 9 },
      { term: "subscription", weight: 7 },
      { term: "firewall", weight: 10 },
      { term: "oracle", weight: 10 },
      { term: "microsoft", weight: 10 },
      { term: "sap", weight: 10 },
      { term: "it support", weight: 10 },
      { term: "cloud", weight: 9 },
      { term: "internet", weight: 8 },
      { term: "telecom", weight: 8 }
    ]
  },
  {
    slug: "maintenance",
    name: "Facilities Maintenance",
    color: "#F59E0B", // amber
    icon: "Wrench",
    keywords: [
      { term: "maintenance", weight: 10 },
      { term: "hvac", weight: 10 },
      { term: "repair", weight: 9 },
      { term: "servicing", weight: 8 },
      { term: "calibration", weight: 9 },
      { term: "overhaul", weight: 8 },
      { term: "elevator", weight: 10 },
      { term: "elevators", weight: 10 },
      { term: "lifts", weight: 9 },
      { term: "air conditioning", weight: 10 },
      { term: "plumbing", weight: 9 },
      { term: "electrical", weight: 7 },
      { term: "facility maintenance", weight: 10 },
      { term: "preventive maintenance", weight: 10 }
    ]
  },
  {
    slug: "construction",
    name: "Construction & Civil Works",
    color: "#10B981", // emerald
    icon: "HardHat",
    keywords: [
      { term: "construction", weight: 10 },
      { term: "building", weight: 8 },
      { term: "installation", weight: 6 },
      { term: "civil", weight: 9 },
      { term: "design", weight: 4 },
      { term: "infrastructure", weight: 9 },
      { term: "renovation", weight: 9 },
      { term: "concrete", weight: 9 },
      { term: "engineering", weight: 7 },
      { term: "piping", weight: 8 },
      { term: "fit-out", weight: 10 },
      { term: "refurbishment", weight: 9 },
      { term: "contracting", weight: 6 }
    ]
  },
  {
    slug: "consulting",
    name: "Professional Services & Consulting",
    color: "#8B5CF6", // purple
    icon: "Briefcase",
    keywords: [
      { term: "consultancy", weight: 10 },
      { term: "consulting", weight: 10 },
      { term: "audit", weight: 9 },
      { term: "advisory", weight: 9 },
      { term: "management", weight: 5 },
      { term: "legal", weight: 9 },
      { term: "financial", weight: 8 },
      { term: "feasibility", weight: 9 },
      { term: "study", weight: 8 },
      { term: "studies", weight: 8 },
      { term: "valuation", weight: 8 },
      { term: "recruitment", weight: 9 }
    ]
  },
  {
    slug: "cleaning",
    name: "Cleaning & Waste Management",
    color: "#22C55E", // green
    icon: "Trash2",
    keywords: [
      { term: "cleaning", weight: 10 },
      { term: "waste", weight: 9 },
      { term: "sanitation", weight: 9 },
      { term: "hygiene", weight: 8 },
      { term: "pest control", weight: 10 },
      { term: "laundry", weight: 10 },
      { term: "janitorial", weight: 10 },
      { term: "disposal", weight: 9 },
      { term: "waste management", weight: 10 },
      { term: "housekeeping", weight: 10 }
    ]
  },
  {
    slug: "food_catering",
    name: "Food & Catering",
    color: "#EF4444", // red
    icon: "Utensils",
    keywords: [
      { term: "food", weight: 10 },
      { term: "catering", weight: 10 },
      { term: "kitchen", weight: 8 },
      { term: "nutrition", weight: 9 },
      { term: "dining", weight: 8 },
      { term: "meals", weight: 9 },
      { term: "cafeteria", weight: 9 },
      { term: "canteen", weight: 9 }
    ]
  },
  {
    slug: "security",
    name: "Security Services",
    color: "#6366F1", // indigo
    icon: "ShieldAlert",
    keywords: [
      { term: "security", weight: 10 },
      { term: "surveillance", weight: 9 },
      { term: "guard", weight: 9 },
      { term: "guards", weight: 9 },
      { term: "safety", weight: 7 },
      { term: "cctv", weight: 10 },
      { term: "fire", weight: 8 },
      { term: "access control", weight: 10 },
      { term: "firefighting", weight: 10 },
      { term: "alarm", weight: 8 }
    ]
  },
  {
    slug: "vehicles",
    name: "Vehicles & Equipment",
    color: "#14B8A6", // teal
    icon: "Car",
    keywords: [
      { term: "vehicle", weight: 10 },
      { term: "vehicles", weight: 10 },
      { term: "car", weight: 9 },
      { term: "cars", weight: 9 },
      { term: "fleet", weight: 9 },
      { term: "machinery", weight: 8 },
      { term: "generator", weight: 9 },
      { term: "generators", weight: 9 },
      { term: "lease", weight: 8 },
      { term: "leasing", weight: 8 },
      { term: "truck", weight: 9 },
      { term: "bus", weight: 9 },
      { term: "buses", weight: 9 }
    ]
  },
  {
    slug: "logistics",
    name: "Logistics & Supply Chain",
    color: "#84CC16", // lime
    icon: "Truck",
    keywords: [
      { term: "warehouse", weight: 9 },
      { term: "delivery", weight: 8 },
      { term: "shipping", weight: 9 },
      { term: "transport", weight: 8 },
      { term: "transportation", weight: 8 },
      { term: "logistics", weight: 10 },
      { term: "storage", weight: 8 },
      { term: "courier", weight: 9 },
      { term: "customs clearance", weight: 10 }
    ]
  },
  {
    slug: "education",
    name: "Education & Training",
    color: "#A855F7", // light purple
    icon: "GraduationCap",
    keywords: [
      { term: "training", weight: 9 },
      { term: "education", weight: 10 },
      { term: "course", weight: 8 },
      { term: "courses", weight: 8 },
      { term: "e-book", weight: 10 },
      { term: "academic", weight: 9 },
      { term: "school", weight: 9 },
      { term: "textbook", weight: 9 },
      { term: "textbooks", weight: 9 },
      { term: "e-books", weight: 10 }
    ]
  }
];

const FALLBACK_CATEGORY = {
  slug: "other",
  name: "Other / Uncategorized",
  color: "#6B7280", // gray
  icon: "HelpCircle"
};

/**
 * Categorizes a tender based on its title.
 * @param {string} title 
 * @returns {{ categorySlug: string, confidence: number }}
 */
function categorize(title) {
  if (!title) {
    return { categorySlug: FALLBACK_CATEGORY.slug, confidence: 0 };
  }

  const normalized = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  
  let bestSlug = FALLBACK_CATEGORY.slug;
  let bestScore = 0;

  for (const cat of CATEGORIES) {
    let score = 0;
    for (const kw of cat.keywords) {
      // Look for exact word boundary matches to prevent substring false-positives
      // e.g. "car" matching "cardiac" or "delivery" matching "liver"
      const escapedTerm = kw.term.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
      const regex = new RegExp(`\\b${escapedTerm}\\b`, "i");
      
      if (regex.test(normalized)) {
        score += kw.weight;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSlug = cat.slug;
    }
  }

  // Calculate confidence based on score
  // If score is 0, confidence is 0. If score >= 10, confidence is 100%. Otherwise, linear scale.
  const confidence = bestScore === 0 ? 0 : Math.min(100, Math.round((bestScore / 10) * 100));

  return { categorySlug: bestSlug, confidence };
}

export {
  CATEGORIES,
  FALLBACK_CATEGORY,
  categorize
};
