/** Team liveries. Shared by the simulation (who is racing) and the renderer. */

export interface Livery {
  name: string;
  color: number;
}

export const LIVERIES: Livery[] = [
  { name: 'APEX', color: 0x34e3ff },
  { name: 'VOLT', color: 0xa6ff3c },
  { name: 'EMBER', color: 0xff7a30 },
  { name: 'NOVA', color: 0xff4fd8 },
  { name: 'GHOST', color: 0xcfe9ff },
  { name: 'PULSE', color: 0x9b6bff },
  { name: 'SOL', color: 0xffcf4a },
  { name: 'RIFT', color: 0xff455d },
];
