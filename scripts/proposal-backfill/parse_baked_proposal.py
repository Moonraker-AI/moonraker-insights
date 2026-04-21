#!/usr/bin/env python3
"""
Parse a baked proposal HTML file and extract the JSONB-compatible
proposal_content shape used by api/generate-proposal.js.

Output matches existing proposal_content schema:
  hero_headline, hero_subtitle            -> str
  exec_summary_paragraphs                 -> str (HTML blob of <p class="lead">...)
  scores                                  -> {c,o,r,e: int}
  credibility_findings, optimization_findings,
    reputation_findings, engagement_findings -> str (HTML blob of <div class="finding">...)
  strategy_intro                          -> str
  strategy_cards                          -> str (HTML blob of <div class="card">...)
  strategy_roi_callout                    -> str (HTML blob of <div class="roi-callout">...)
  timeline_items                          -> str (HTML blob of <div class="timeline-item">...)
  next_steps                              -> list[{title, desc}]
"""
import json
import re
import sys
from bs4 import BeautifulSoup


def inner_html_of_children(parent):
    """Return concatenated outerHTML of child elements, no whitespace between."""
    return ''.join(str(c) for c in parent.children if getattr(c, 'name', None))


def extract(html_path):
    with open(html_path) as f:
        html = f.read()
    soup = BeautifulSoup(html, 'html.parser')

    content = {}

    # ── hero_headline + hero_subtitle ──────────────────────────────
    hero_h1 = soup.select_one('.hero h1')
    hero_sub = soup.select_one('.hero .subtitle')
    content['hero_headline'] = hero_h1.get_text(strip=True) if hero_h1 else ''
    content['hero_subtitle'] = hero_sub.get_text(strip=True) if hero_sub else ''

    # ── exec_summary_paragraphs ────────────────────────────────────
    # Everything wrapped in <p class="lead"> in the #executive section.
    exec_section = soup.select_one('#summary')
    if exec_section:
        leads = exec_section.select('p.lead')
        content['exec_summary_paragraphs'] = ''.join(str(p) for p in leads)
    else:
        content['exec_summary_paragraphs'] = ''

    # ── scores ──────────────────────────────────────────────────────
    # .score-card with .score-pillar label mapping Credibility/Optimization/
    # Reputation/Engagement to keys c/o/r/e.
    scores = {}
    pillar_map = {
        'Credibility': 'c',
        'Optimization': 'o',
        'Reputation': 'r',
        'Engagement': 'e',
    }
    for card in soup.select('.score-card'):
        pillar_el = card.select_one('.score-pillar')
        val_el = card.select_one('.score-val')
        if not pillar_el or not val_el:
            continue
        pillar = pillar_el.get_text(strip=True)
        # .score-val contains "<int><span>/10</span>"
        val_text = val_el.contents[0] if val_el.contents else '0'
        try:
            val = int(str(val_text).strip())
        except ValueError:
            val = 0
        key = pillar_map.get(pillar)
        if key:
            scores[key] = val
    content['scores'] = scores

    # ── *_findings (4 collapsibles inside #assessment) ────────────
    finding_map = {
        'Credibility': 'credibility_findings',
        'Optimization': 'optimization_findings',
        'Reputation': 'reputation_findings',
        'Engagement': 'engagement_findings',
    }
    # Initialize all to empty
    for v in finding_map.values():
        content[v] = ''
    for collapsible in soup.select('.collapsible'):
        toggle = collapsible.select_one('.collapsible-toggle span')
        inner = collapsible.select_one('.collapsible-content-inner')
        if not toggle or not inner:
            continue
        header = toggle.get_text(strip=True)
        # Header format: "Credibility: Can You Prove You Exist?"
        pillar_name = header.split(':')[0].strip()
        key = finding_map.get(pillar_name)
        if not key:
            continue
        findings = inner.select('div.finding')
        content[key] = ''.join(str(f) for f in findings)

    # ── strategy_intro, strategy_cards, strategy_roi_callout ──────
    strategy_section = soup.select_one('#strategy')
    content['strategy_intro'] = ''
    content['strategy_cards'] = ''
    content['strategy_roi_callout'] = ''
    if strategy_section:
        container = strategy_section.select_one('.container')
        if container:
            # First paragraph after h2 is the intro
            h2 = container.select_one('h2')
            if h2:
                sib = h2.find_next_sibling()
                # Skip past the intro paragraph
                if sib and sib.name == 'p':
                    content['strategy_intro'] = sib.get_text(strip=True)
            # Cards and roi callout
            cards = container.select('div.card')
            content['strategy_cards'] = ''.join(str(c) for c in cards)
            # The roi-callout inside strategy section (not timeline or investment)
            # There may be multiple .roi-callout on the page. The strategy one is
            # the direct child of the strategy container (or sibling of cards).
            roi = None
            for r in container.select('.roi-callout'):
                # The strategy ROI sits inside #strategy's .container; timeline
                # doesn't use .roi-callout. Investment ROI sits inside #investment.
                roi = r
                break
            if roi is not None:
                content['strategy_roi_callout'] = str(roi)

    # ── timeline_items ─────────────────────────────────────────────
    timeline_section = soup.select_one('#timeline')
    content['timeline_items'] = ''
    if timeline_section:
        items = timeline_section.select('.timeline-item')
        content['timeline_items'] = ''.join(str(i) for i in items)

    # ── next_steps ─────────────────────────────────────────────────
    # Schema: [{title, desc}]
    # Modern layout: each <div class="next-step"> with <h4> + <p>.
    # Older layout (Ray): inline flex divs inside a <div class="card">
    # where each "step" has <h4>...<p>. Fall back to: any h4 under the
    # section whose nearest following <p> sibling is the description.
    next_steps_section = soup.select_one('#next')
    steps = []
    if next_steps_section:
        # Try the modern selector first.
        modern_steps = next_steps_section.select('.next-step')
        if modern_steps:
            for step in modern_steps:
                h4 = step.select_one('h4')
                p = step.select_one('p')
                if h4 and p:
                    steps.append({
                        'title': h4.get_text(strip=True),
                        'desc': p.get_text(strip=True),
                    })
        else:
            # Fallback: walk every h4 in the section, pair with next p sibling.
            for h4 in next_steps_section.select('h4'):
                # Find the <p> that's either a direct sibling or inside the
                # same parent container as the h4.
                p = h4.find_next('p')
                if p is not None:
                    steps.append({
                        'title': h4.get_text(strip=True),
                        'desc': p.get_text(strip=True),
                    })
    content['next_steps'] = steps

    return content


if __name__ == '__main__':
    path = sys.argv[1]
    result = extract(path)
    print(json.dumps(result, indent=2))
