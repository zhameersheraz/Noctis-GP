/** Why does catch-up make a weak player fall further behind? */
import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector } from '../src/sim/race';
import { AIController } from '../src/sim/ai';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';

const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);

function run(catchUp: boolean, skill: number) {
  const d = new RaceDirector({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
    terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()),
    autopilot: true, menu: null,
  });
  d.catchUp = catchUp;
  d.classifyOnPlayerFinish = false;
  d.startRace();
  const pa = d.player.ai as AIController;
  pa.skill = skill;
  pa.boldness = skill;

  let offRoadFrames = 0, frames = 0, resets = 0, maxGap = 0;
  const biasSamples: number[] = [];
  for (let i = 0; i < 60 * 240; i++) {
    d.update(1 / 60);
    frames++;
    if (d.player.offroad > 0.5) offRoadFrames++;
    if (i % 600 === 0) {
      const a = d.order[0];
      if (a && a.ai && a !== d.player) biasSamples.push((a.ai as AIController).debugBias());
    }
    let lead = -Infinity;
    for (const c of d.cars) if (c !== d.player) lead = Math.max(lead, c.totalDist);
    if (Number.isFinite(lead)) maxGap = Math.max(maxGap, lead - d.player.totalDist);
    if (d.cars.every((c) => c.finished)) break;
  }
  const a = d.order[0] as AIController | null;
  void a;
  const leader = d.order[0];
  return {
    maxGap,
    playerLaps: d.player.lapTimes.length,
    playerFinished: d.player.finished,
    playerTime: d.player.finished ? d.player.finishTime : Infinity,
    offRoadPct: (offRoadFrames / frames) * 100,
    leaderLapTimes: leader.lapTimes.length,
    leaderBias: biasSamples,
    playerAvgSpeed: d.player.lapTimes.length
      ? (track.length * d.player.lapTimes.length) / d.player.lapTimes.reduce((a2, b) => a2 + b, 0)
      : 0,
  };
}

for (const cu of [false, true]) {
  const r = run(cu, 0.88);
  console.log(`\ncatchUp=${cu}`);
  console.log(`  player laps=${r.playerLaps} finished=${r.playerFinished} time=${r.playerTime.toFixed(1)}s`);
  console.log(`  player avg speed = ${r.playerAvgSpeed.toFixed(1)} m/s (${(r.playerAvgSpeed * 3.6).toFixed(0)} km/h)`);
  console.log(`  leader laps=${r.leaderLapTimes}`);
  console.log(`  worst gap = ${r.maxGap.toFixed(0)} m`);
  console.log(`  player off-road ${r.offRoadPct.toFixed(1)}% of frames`);
  console.log(`  leader bias samples = ${r.leaderBias.map((b) => b.toFixed(2)).join(', ')}`);
}
