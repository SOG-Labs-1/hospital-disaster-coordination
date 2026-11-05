import type { Proposal, RoleContext } from '@hdc/shared';
import type { AiProvider, ReviewExplainInput, ReviewExplanation } from './provider';

/**
 * API を使わない部署役。決まった規則で返事をする。テストとデモの確実な再現に使う。
 * 受け入れの判断は、自部署の受け入れ枠（RoleContext に含まれる自部署の状態）だけで決める
 */
export class MockProvider implements AiProvider {
  readonly name = 'mock';

  async proposeForRole(ctx: RoleContext): Promise<(Proposal | null)[]> {
    const me = ctx.locationName;
    const s = ctx.stimulus;
    switch (s.kind) {
      case 'patientArrived':
        return [{ action: 'reply_message', message: `${me}です。患者が到着しました。${ctx.stimulusText.match(/（(.+)）/)?.[1] ?? ''}です。` }];
      case 'statusChanged':
        return [
          {
            action: 'report_status',
            message: `${me}です。${s.accepting === false ? '受け入れできません' : '受け入れできます'}${s.capacity?.length ? `。${s.capacity.map((c) => `${ctx.ownStatus.capacity.find((x) => x.triage === c.triage)?.label ?? c.triage}は${c.value}人まで`).join('、')}` : ''}${s.note ? `。${s.note}` : ''}。`,
            accepting: s.accepting ?? null,
            capacity: s.capacity ?? [],
          },
        ];
      case 'needSupport':
        return [{ action: 'request_support', message: `${me}です。応援をお願いします。${ctx.stimulusText.replace(/^.*：/, '').replace(/。本部へ要請する。$/, '')}。` }];
      case 'notice':
        return [{ action: 'reply_message', message: `${ctx.roleKind === 'transporter' ? '搬送' : me}です。${s.text}。` }];
      case 'transportRequest': {
        const room = ctx.ownStatus.accepting && ctx.ownStatus.capacity.some((c) => c.value > 0);
        return room
          ? [{ action: 'accept_transport', transportId: s.transportId, message: `${me}です。${s.transportId}、受け入れできます。準備して待っています。` }]
          : [{ action: 'decline_transport', transportId: s.transportId, reason: '受け入れ枠がない', message: `${me}です。${s.transportId}は、いま受け入れられる枠がありません。` }];
      }
      case 'transportOrdered':
        return [{ action: 'report_departure', transportId: s.transportId, message: `${me}です。${s.transportId}、患者さんが出発しました。` }];
      case 'patientArrivedByTransport':
        return [{ action: 'report_arrival', transportId: s.transportId, message: `搬送です。${s.transportId}、到着先に着きました。引き渡しました。` }];
      case 'supportArrived':
        return [{ action: 'reply_message', message: `${me}です。応援（${s.itemsText}）が届きました。ありがとうございます。` }];
      case 'hqMessage': {
        // 搬送要員：本部の無線の指示に、搬送の番号（T-001）があれば、その搬送を運び出す。番号がなく、出発前の搬送が1件だけならそれを運ぶ
        if (ctx.roleKind === 'transporter') {
          const named = s.text.match(/T-\d+/)?.[0];
          const waiting = ctx.transports.filter((t) => t.status === '受け入れ了承済み・出発前' || t.status === '受け入れの返事待ち');
          const id = named ?? (waiting.length === 1 ? waiting[0]!.id : undefined);
          return id
            ? [{ action: 'report_departure', transportId: id, message: `搬送です。${id}、了解しました。患者さんと出発しました。` }]
            : [{ action: 'reply_message', message: '搬送です。了解しました。どの搬送か、番号を教えてください。' }];
        }
        return [{ action: 'reply_message', message: `${me}です。了解しました。` }];
      }
    }
  }

  async explainReview(input: ReviewExplainInput): Promise<ReviewExplanation[]> {
    return input.findings.map((f) => ({
      findingId: f.id,
      text: `${f.title}。${f.detail}${f.participantNote ? `（参加者の補足：${f.participantNote}）` : ''}`,
      evidence: f.evidence,
    }));
  }
}
