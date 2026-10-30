# Job Work Manager (React + Zoho Books)

Local web app for job work (coating) with Zoho Books as the books of record.

```
DC create (draft) → Print → Confirm ──► Books: Inventory Adjustment (raw OUT) + Purchase Order (coating service)
                                   Receive ──► Books: Inventory Adjustment (coated IN at raw cost + coating cost)
                                   Books:  Bill from PO → Payment   (done in Books as usual)
                                   Close  ──► Books: Journal (scrap/short)   |   Cancel ──► reverse adjustment + cancel PO
```

The app keeps DCs, item mapping and coating rates in `server/data/db.json`. The refresh token stays in `server/.env` on your PC and is never sent to the browser.

---

## 1. One-time Zoho setup

### a) API credentials (Self Client)
1. Open https://api-console.zoho.in → **Add Client → Self Client** → note **Client ID** and **Client Secret**.
2. In Self Client → **Generate Code**:
   - Scope: `ZohoBooks.fullaccess.all`
   - Time: 10 minutes → Create → copy the code.
3. Copy `server/.env.example` to `server/.env` and fill `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`.
4. Run (within 10 minutes of generating the code):
   ```
   cd server
   node get-token.js <PASTE_CODE>
   ```
   Paste the printed refresh token into `.env` as `ZOHO_REFRESH_TOKEN`.
5. `ZOHO_ORG_ID`: Books → Settings → Organization Profile → Organization ID.

### b) In Zoho Books
| Create | Type | Purpose |
|---|---|---|
| **Job Work Clearing** account | Other Current Asset | Every adjustment posts here. Its balance = raw material lying with job workers |
| **Job Work Scrap / Loss** account | Expense | Used when a DC is closed with short/scrap |
| **Coating Charges** item | Service, SAC 998821, purchase account = **Job Work Clearing**, tax IGST 18% | Line item on the PO / bill |
| Coated items, e.g. `LT.08 SA-10` | Goods (inventory), unit Nos | The new item that comes back |

## 2. Run

Needs Node.js 18 or newer.

```
npm run install:all
npm run dev
```
Open http://localhost:5173 → **Settings** → select the Clearing account, Scrap account and Coating service item → Save.

## 3. Daily use
1. **New DC** → job worker, raw item (SKU), coating, new item, parameter, length, pcs, rate/sqft.
   Raw cost/pc fills from the item's purchase rate; correct it if needed.
2. **Print DC**, then **Confirm** → raw stock goes out in Books and the PO is created (reference = DC no).
3. When material comes back → **Receive material** (partial allowed) → coated stock comes in at *raw cost + coating cost*.
4. In Books → open the PO → **Convert to Bill** for the received qty (match the vendor invoice) → record payment.
5. Anything that never comes back → **Close DC** → posts the scrap/short journal.

**Pending with job worker** shows the balance per DC and line, with ageing. Its total should match the Job Work Clearing balance once all bills are entered.

## 4. Accounting check (example: LT.08, 25 sent, raw ₹400/pc, coating ₹195.90/pc)
| Event | Clearing account |
|---|---|
| Confirm: raw out 25 × 400 | +10,000 |
| Receive 20 coated @ 595.90 | −11,918 |
| Bill 20 × 195.90 (coating) | +3,918 |
| Close: 5 scrap × 400 → Scrap Loss | −2,000 |
| **Balance** | **0** |

## 5. Before going live — test once
- Make one small DC with 1 pc and check it in Books:
  - the inventory adjustment shows the correct **cost price**. The app sends `item_total` = qty × cost.
  - the PO has the right tax.
- If your org uses multiple locations/warehouses, select the location in Settings.
- Back up `server/data/db.json` regularly. It is the only copy of DCs and receipts.

## Notes
- E-way bill: enter the number on the DC; generation is not automated.
- DC print follows Rule 55 job-work challan fields; review the terms text in `client/src/pages/DCPrint.jsx`.
