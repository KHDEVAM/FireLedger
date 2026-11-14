import { fmt, t } from '../i18n';
import { escapeHtml } from '../ui';
import { advisoryConfig, compass, resourcesFor, stagingSites, type Assessment, type Context, type Exposure, type Place, type Weather } from './engine';

export interface AdvisoryItem {
  text: string;
  why?: string;
}

export interface AdvisoryCard {
  title: string;
  items: AdvisoryItem[];
}

export interface AdvisoryDoc {
  tier: number;
  tierLabel: string;
  headline: string;
  triggers: string[];
  cards: AdvisoryCard[];
  guardrails: string[];
  sms: string;
  simulated: boolean;
}

export interface AdvisoryInput {
  assessment: Assessment;
  weather: Weather | null;
  exposure: Exposure | null;
  ctx: Context;
  regionCode: string;
  areaName: string;
  /** hotspots seen in the last 7 days but none inside the current window */
  postFire: boolean;
  simulated: boolean;
}

const place = (p: Place) => `${p.name} (${p.distKm.toFixed(1)} km ${compass(p.bearing)})`;

export function buildAdvisory(input: AdvisoryInput): AdvisoryDoc {
  const { assessment: a, weather: w, exposure: x, ctx } = input;
  const cfg = advisoryConfig;
  const tierLabel = t(`tier.${a.tier}`);
  const cards: AdvisoryCard[] = [];
  const tierWhy = t('adv.why.tier', { tier: a.tier, label: tierLabel });

  const guardrails = [t('adv.guard.latency'), t('adv.guard.limits'), t('adv.guard.support'), t('footer.safety')];
  const headline =
    a.tier === 0
      ? t('adv.none', { hours: ctx.windowH })
      : t('adv.headline', { count: a.count, hours: ctx.windowH, clusters: a.clusters.length, area: input.areaName });

  if (a.tier > 0 && a.primary) {
    const p = a.primary;
    const situation: AdvisoryItem[] = [
      { text: t('adv.sit.count', { count: a.count, clusters: a.clusters.length, sig: a.significantClusters, min: cfg.clusterMinPoints }) },
      { text: t('adv.sit.frp', { total: fmt(a.frpTotal), max: fmt(a.frpMax) }) },
      { text: t('adv.sit.primary', { lat: p.lat.toFixed(3), lon: p.lon.toFixed(3), n: p.points.length, area: p.areaKm2.toFixed(1) }) },
      { text: t(a.last24 > a.prev24 ? 'adv.sit.up' : a.last24 < a.prev24 ? 'adv.sit.down' : 'adv.sit.flat', { last: a.last24, prev: a.prev24 }) },
    ];
    if (w && a.spreadBearing !== null)
      situation.push({
        text: t('adv.sit.spread', { dir: compass(a.spreadBearing), deg: Math.round(a.spreadBearing) }),
        why: t('adv.why.wind', { kmh: Math.round(w.windKmh), from: compass(w.windDirFrom), gust: Math.round(w.gustKmh), rh: Math.round(w.rh), temp: Math.round(w.tempC) }),
      });
    else situation.push({ text: t('adv.sit.noweather') });
    if (w && w.maxWind72 !== null && w.minRh72 !== null) situation.push({ text: t('adv.sit.forecast', { wind: Math.round(w.maxWind72), rh: Math.round(w.minRh72) }) });
    cards.push({ title: t('adv.card.situation'), items: situation });

    const res = resourcesFor(a);
    const range = ([lo, hi]: [number, number]) => (lo === hi ? String(lo) : `${lo}–${hi}`);
    cards.push({
      title: t('adv.card.resources'),
      items: [
        ...Object.entries(res)
          .filter(([, r]) => r[1] > 0)
          .map(([key, r]) => ({ text: `${t(`adv.res.${key}`)}: ${range(r)}` })),
        { text: t('adv.res.note'), why: `${tierWhy} · ${t('adv.why.clusters', { n: Math.max(a.significantClusters, 1) })}` },
      ],
    });

    const logistics: AdvisoryItem[] = [];
    if (x) {
      const sites = stagingSites(x, w);
      logistics.push(
        sites.length
          ? { text: t('adv.log.staging', { list: sites.map(place).join('; ') }), why: t('adv.why.staging', { min: cfg.stagingMinKm, max: cfg.stagingMaxKm }) }
          : { text: t('adv.log.nostaging', { min: cfg.stagingMinKm, max: cfg.stagingMaxKm }) },
      );
      logistics.push(x.water.length ? { text: t('adv.log.water', { list: x.water.slice(0, 3).map(place).join('; ') }) } : { text: t('adv.log.nowater') });
      if (x.fireStations.length) logistics.push({ text: t('adv.log.station', { list: x.fireStations.slice(0, 2).map(place).join('; ') }) });
    } else logistics.push({ text: t('adv.log.noosm') });
    logistics.push({ text: t('adv.log.access') }, { text: t('adv.log.shifts') }, { text: t('adv.log.comms') });
    cards.push({ title: t('adv.card.logistics'), items: logistics });

    const people: AdvisoryItem[] = [];
    if (x) {
      if (a.nearestSettlement) people.push({ text: t('adv.pop.nearest', { place: place(a.nearestSettlement) }) });
      if (a.downwindSettlements.length)
        people.push({
          text: t('adv.pop.downwind', { list: a.downwindSettlements.slice(0, 5).map(place).join('; ') }),
          why: t('adv.why.cone', { deg: cfg.downwindConeDeg, km: cfg.downwindRangeKm }),
        });
      else if (w) people.push({ text: t('adv.pop.nodownwind', { km: cfg.downwindRangeKm }) });
      people.push({ text: t('adv.pop.count', { p5: fmt(a.pop.km5), p10: fmt(a.pop.km10), p25: fmt(a.pop.km25) }), why: t('adv.why.pop', { n: a.pop.tagged }) });
      if (x.hospitals.length) people.push({ text: t('adv.pop.hospitals', { list: x.hospitals.slice(0, 2).map(place).join('; ') }) });
      if (x.schools.length) people.push({ text: t('adv.pop.shelters', { list: x.schools.slice(0, 3).map(place).join('; ') }) });
    } else people.push({ text: t('adv.pop.noosm') });
    if (a.tier >= 3) people.push({ text: t('adv.pop.evac'), why: tierWhy });
    people.push({ text: t('adv.pop.smoke') });
    cards.push({ title: t('adv.card.population'), items: people });

    if (ctx.peakMonth && a.tier <= 2) cards.push({ title: t('adv.card.agri'), items: [{ text: t('adv.agri.text'), why: t('adv.why.agri') }] });
  }

  if (input.postFire)
    cards.push({ title: t('adv.card.post'), items: ['adv.post.assess', 'adv.post.erosion', 'adv.post.report', 'adv.post.archive'].map((k) => ({ text: t(k) })) });

  const contacts = (cfg.contacts as Record<string, (typeof cfg.contacts)['default']>)[input.regionCode] ?? cfg.contacts.default;
  cards.push({
    title: t('adv.card.contacts'),
    items: [
      ...contacts.numbers.filter((n) => n.number).map((n) => ({ text: `${n.label}: ${n.number}` })),
      ...contacts.numbers.filter((n) => !n.number).map((n) => ({ text: `${n.label}: ${t('adv.contacts.lookup')}` })),
      { text: contacts.verified ? contacts.note : t('adv.contacts.unverified') },
    ],
  });

  const triggers = a.triggers.map((tr) => `${t('adv.tierword')} ${tr.tier} — ${t(`trig.${tr.code}`, tr.params)}`);

  let sms = a.tier === 0 ? `FireLedger: ${headline}` : `FireLedger ${tierLabel.toUpperCase()} (${a.tier}/4): ${headline}`;
  if (a.tier > 0 && a.primary) {
    sms += ` ${t('adv.sms.main', { lat: a.primary.lat.toFixed(3), lon: a.primary.lon.toFixed(3), frp: fmt(a.frpTotal) })}`;
    if (w && a.spreadBearing !== null) sms += ` ${t('adv.sms.wind', { kmh: Math.round(w.windKmh), dir: compass(a.spreadBearing) })}`;
    if (a.nearestSettlement) sms += ` ${t('adv.sms.near', { place: place(a.nearestSettlement) })}`;
  }
  sms += ` ${t('adv.sms.tail')}`;
  if (input.simulated) sms = `[${t('adv.simulated.short')}] ${sms}`;
  if (sms.length > 600) sms = `${sms.slice(0, 597)}...`;

  return { tier: a.tier, tierLabel, headline, triggers, cards, guardrails, sms, simulated: input.simulated };
}

export function renderAdvisory(container: HTMLElement, doc: AdvisoryDoc): void {
  const icon = ['●', '●', '▲', '▲', '▲'][doc.tier];
  const cards = doc.cards
    .map(
      (c) =>
        `<section class="adv-card"><h3>${escapeHtml(c.title)}</h3><ul>${c.items
          .map((i) => `<li>${escapeHtml(i.text)}${i.why ? `<span class="why">${t('adv.because')}: ${escapeHtml(i.why)}</span>` : ''}</li>`)
          .join('')}</ul></section>`,
    )
    .join('');
  container.innerHTML = `
    ${doc.simulated ? `<p class="banner danger"><span class="sim-flag">${escapeHtml(t('adv.simulated'))}</span></p>` : ''}
    <div class="tier" data-tier="${doc.tier}">
      <span class="tier-label"><span aria-hidden="true">${icon}</span> ${escapeHtml(t('adv.tierword'))} ${doc.tier} · ${escapeHtml(doc.tierLabel)}</span>
      <span>${escapeHtml(doc.headline)}</span>
    </div>
    ${doc.triggers.length ? `<details open><summary><strong>${escapeHtml(t('adv.whytitle'))}</strong></summary><ul>${doc.triggers.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></details>` : ''}
    <div class="adv-cards">${cards}</div>
    <ul class="hint">${doc.guardrails.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul>
    <div class="toolbar">
      <button class="btn" type="button" data-adv="pdf">${escapeHtml(t('adv.pdf'))}</button>
      <button class="btn" type="button" data-adv="sms">${escapeHtml(t('adv.sms'))}</button>
      <span class="hint" role="status" aria-live="polite" id="adv-status"></span>
    </div>`;
}
