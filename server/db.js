// Tiny JSON-file store. Everything the app owns (DCs, mappings, rates, settings)
// lives in server/data/db.json. Back this file up.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const file = path.join(dir, 'db.json');

const DEFAULTS = {
  settings: {
    company: {
      name: 'WORK PLACE SYNERGIES PVT LTD',
      address: 'Khasra No. 434, Westend Green Farm House Road, Rangpuri, Mahipalpur, South West Delhi, Delhi 110037',
      gstin: '07AACCA0650M1ZT',
      state: 'Delhi (07)',
      phone: '',
      dispatchAddress: '', // warehouse the goods leave from; blank = company address
      pan: '',
      cin: '',
      regdOffice: 'Khasra No. 434, Westend Green Farm House Road New Delhi - 110037',
      bankBeneficiary: '',
      bankName: '',
      bankAddress: '',
      bankAccount: '',
      bankIfsc: '',
      terms: [
        'Goods sent for job work only; ownership remains with the principal.',
        'Processed goods / scrap to be returned within the period allowed under Sec. 143 of the CGST Act.',
        'All disputes are subject to NEW DELHI jurisdiction.',
      ].join('\n'),
    },
    dcGstRate: 18, // % shown on the DC print (value for e-way bill); not posted anywhere
    sqftFactor: 10.764,
    adjustmentReason: 'Job Work',
    clearingAccountId: '',
    clearingAccountName: '',
    scrapAccountId: '',
    scrapAccountName: '',
    coatingServiceItemId: '',
    coatingServiceItemName: '',
    purchaseTaxId: '',
    locationId: '',
    // new items created from a DC; blank = Books default by name (Sales Accounts, Cost of Goods Sold, Inventory Asset, GST18, IGST18)
    itemSalesAccountId: '',
    itemPurchaseAccountId: '',
    itemInventoryAccountId: '',
    itemTaxIntraId: '',
    itemTaxInterId: '',
    coatings: ['SA-10+DECOAT', 'SA-06+DECOAT', '511+DECOAT', 'RAL-7016'],
  },
  mappings: [], // { id, rawItemId, rawName, coating, coatedItemId, coatedName }
  rates: [],    // { id, vendorId, vendorName, coating, ratePerSqft }
  dcs: [],
};

let state;

function load() {
  if (state) return state;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    state = structuredClone(DEFAULTS);
    save();
  } else {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.settings = { ...DEFAULTS.settings, ...state.settings };
    state.settings.company = { ...DEFAULTS.settings.company, ...state.settings.company };
    for (const k of ['mappings', 'rates', 'dcs']) state[k] ||= [];
  }
  return state;
}

export function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export const db = () => load();
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
