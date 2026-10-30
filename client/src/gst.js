// GST state codes (first two digits of a GSTIN)
export const STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
// "07AACCA0650M1ZT" -> "07-Delhi"
export const stateOf = (gstin) => { const c = String(gstin || '').slice(0, 2); return STATES[c] ? `${c}-${STATES[c]}` : ''; };

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Same state as the dispatching GSTIN -> CGST + SGST, otherwise IGST.
// placeOfSupply is "09-Uttar Pradesh" style; an empty one counts as same state.
export const isIntra = (placeOfSupply, fromGstin) => !placeOfSupply || String(placeOfSupply).slice(0, 2) === String(fromGstin || '').slice(0, 2);

// DC line money: qty x rate - discount = taxable, GST split by intra / inter state
export function lineTax(l, intra) {
  const rate = Number(l.gstRate) || 0;
  const amount = r2((Number(l.pcs) || 0) * (Number(l.rawCostPerPc) || 0));
  const discount = r2(l.discount);
  const taxable = r2(amount - discount);
  const tax = r2(taxable * rate / 100);
  const cgst = intra ? r2(tax / 2) : 0;
  const sgst = intra ? r2(tax - cgst) : 0;
  return { rate, amount, discount, taxable, cgst, sgst, igst: intra ? 0 : tax, total: r2(taxable + tax) };
}
