// Przykładowa baza materiałów wybuchowych. Wartości orientacyjne: przed użyciem zastąp danymi z kart produktów.
export const DEFAULT_PRODUCTS = [
  { id: 'emu-bulk', name: 'Emulsja pompowana (przykład)', kind: 'bulk', density: 1.2, color: '#ff6b3d' },
  { id: 'anfo', name: 'ANFO sypki (przykład)', kind: 'bulk', density: 0.85, color: '#ffd23f' },
  { id: 'nab-32', name: 'Emulsja nabojowana Ø32 × 400 mm (przykład)', kind: 'cartridge', cartDia: 32, cartLen: 400, cartMass: 0.4, color: '#ff3d71' },
  { id: 'nab-65', name: 'Emulsja nabojowana Ø65 × 500 mm (przykład)', kind: 'cartridge', cartDia: 65, cartLen: 500, cartMass: 2, color: '#c63dff' },
  { id: 'nab-80', name: 'Emulsja nabojowana Ø80 × 500 mm (przykład)', kind: 'cartridge', cartDia: 80, cartLen: 500, cartMass: 3, color: '#3d8bff' },
];

export function newProductId() {
  return 'p-' + Math.random().toString(36).slice(2, 8);
}
