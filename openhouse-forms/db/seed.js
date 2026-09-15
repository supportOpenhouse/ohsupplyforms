require('dotenv').config();
const pool = require('./pool');

// ═══════════════════════════════════════════════════════════
// MASTER DATA: City → Locality → Society
// Extracted from the uploaded Excel screenshot.
// To add more societies later, just add rows here and re-run:
//   node db/seed.js
//
// SAFE TO RE-RUN. This list is the ORIGINAL import (~51 rows) and is long since
// outgrown by the live table (~1,160 rows). It also carries only the three name
// columns, while the live rows also hold `micro_market`, `affordable` and
// `active` — all set elsewhere (admin UI / SQL), none of them here.
//
// So this seed is strictly ADDITIVE: it inserts rows that are missing and never
// updates or deletes an existing one. It used to `DELETE FROM master_societies`
// first, which on today's data would have destroyed 1,161 rows to reinsert 51,
// taking every micro_market, every affordable flag, and the `active` flags that
// block submissions with it — silently, and on a table six other services read.
// ═══════════════════════════════════════════════════════════

const SOCIETIES = [
  // ── GURGAON ──
  ["Gurgaon", "Sector 104", "Hero Homes"],
  ["Gurgaon", "Sector 102", "Shapoorji Pallonji Joyville Gurugram"],
  ["Gurgaon", "Sector 69", "Tulip Yellow"],
  ["Gurgaon", "Sector 65", "M3M Heights"],
  ["Gurgaon", "Sector 67A", "Ireo The Corridors"],
  ["Gurgaon", "Sector 59", "Conscient Elevate"],
  ["Gurgaon", "Sector 106", "Godrej Meridien"],
  ["Gurgaon", "Sector 108", "Sobha City"],
  ["Gurgaon", "Sector 89", "Smart World Gems"],
  ["Gurgaon", "Sector 102", "Adani M2K Oyster Grande"],
  ["Gurgaon", "Sector 66", "Emaar MGF The Palm Drive"],
  ["Gurgaon", "Sector 79", "Bestech Altura"],
  ["Gurgaon", "Sector 69", "Tulip Violet"],
  ["Gurgaon", "Sector 61", "Smart World Orchard"],
  ["Gurgaon", "Sector 104", "Puri Emerald Bay"],
  ["Gurgaon", "Sector 65", "M3M Golfestate"],
  ["Gurgaon", "Sector 81", "DLF The Ultima"],

  // ── NOIDA ──
  ["Noida", "Sector 43", "Godrej Woods"],
  ["Noida", "Sector 4", "Amrapali Golf Homes"],
  ["Noida", "Sector 137", "Paras Tierea"],
  ["Noida", "Sector 107", "Amrapali HeartBeat City"],
  ["Noida", "Sector Chi 5", "Purvanchal Royal City"],
  ["Noida", "Sector 16C", "Gaur City 2 14th Avenue"],
  ["Noida", "Sector 76", "Amrapali Silicon City"],
  ["Noida", "Sector 121", "ABA Cleo County"],
  ["Noida", "Sector 1 West", "ACE Divino"],
  ["Noida", "Sector 134", "Jaypee Greens Kosmos"],
  ["Noida", "Sector 16", "Panchsheel Greens 2"],
  ["Noida", "Sector 74", "Supertech Cape Town"],
  ["Noida", "Sector 110", "3C Lotus Panache"],
  ["Noida", "Sector 152", "Ace Starlit"],
  ["Noida", "Techzone 4 West", "Gaur Saundaryam"],
  ["Noida", "Sector 150", "ACE Parkway"],
  ["Noida", "Techzone 4 West", "Nirala Estate"],

  // ── GHAZIABAD ──
  ["Ghaziabad", "Siddharth Vihar", "Prateek Grand City"],
  ["Ghaziabad", "Ahinsa Khand 1", "ATS Advantage"],
  ["Ghaziabad", "Vaibhav Khand", "Saya Gold Avenue"],
  ["Ghaziabad", "Ahinsa Khand 2", "Niho Scottish Garden"],
  ["Ghaziabad", "NH 24 Highway", "Landcraft Golflinks"],
  ["Ghaziabad", "Ahinsa Khand 2", "Trine Towers"],
  ["Ghaziabad", "Raj Nagar Extension", "VVIP Addresses"],
  ["Ghaziabad", "Crossing Republik", "Panchsheel Wellington"],
  ["Ghaziabad", "NH 24 Highway", "Mahagun Puram"],
  ["Ghaziabad", "Sector 1 Vaishali", "Rishabh Cloud 9 Towers"],
  ["Ghaziabad", "Raj Nagar Extension", "KW Srishti"],
  ["Ghaziabad", "Crossing Republik", "Paramount Symphony"],
  ["Ghaziabad", "Ahinsa Khand 2", "Angel Jupiter"],
  ["Ghaziabad", "Raj Nagar Extension", "Eureka Diya Greencity"],
  ["Ghaziabad", "Crossing Republik", "Ajnara Gen 10"],
  ["Ghaziabad", "Raj Nagar Extension", "SVP Gulmohur Garden"],
  ["Ghaziabad", "NH 24 Highway", "Wave Dream Homes"],
];

async function seed() {
  console.log('Seeding society data...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [before] } = await client.query('SELECT COUNT(*)::int AS n FROM master_societies');

    // Insert-only. DO NOTHING on conflict, so an existing row keeps its
    // micro_market / affordable / active exactly as they are.
    const insertSQL = `
      INSERT INTO master_societies (city, locality, society_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (city, locality, society_name) DO NOTHING
    `;

    let added = 0;
    for (const [city, locality, society] of SOCIETIES) {
      const { rowCount } = await client.query(insertSQL, [city, locality, society]);
      added += rowCount;
    }

    await client.query('COMMIT');

    // Print summary
    const result = await client.query(`
      SELECT city, COUNT(*) as count 
      FROM master_societies 
      GROUP BY city ORDER BY city
    `);
    console.log('✓ Society data seeded (insert-only — nothing was deleted or overwritten):');
    result.rows.forEach(r => console.log(`  ${r.city}: ${r.count} societies`));
    console.log(`  Added ${added} new row(s); ${before.n} existed before, ${before.n + added} now.`);
    if (added === 0) console.log('  (every row in this file was already present)');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  seed().catch(() => process.exit(1));
}

module.exports = { seed, SOCIETIES };
