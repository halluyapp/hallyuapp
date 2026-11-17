-- Preserve distinct research dates and uncertainty; existing research remains untouched.
alter table public.operator_research_item add column event_at timestamptz;
alter table public.operator_research_item add column uncertainty text;
alter table public.operator_research_item add column retrieved_at timestamptz not null default now();
update public.operator_tool set input_schema = jsonb_set(
  jsonb_set(input_schema,'{properties}',input_schema->'properties' || '{"published_at":{"type":"string","description":"Source publication ISO timestamp, only when supplied by the source"},"event_at":{"type":"string","description":"Event ISO timestamp, not the publication date"},"uncertainty":{"type":"string","maxLength":1000}}'::jsonb),
  '{required}','["topic","headline","source_url"]'::jsonb)
where name='research.save';

-- Add sourced operational knowledge without overwriting human-maintained entries.
with added as (
insert into public.operator_knowledge(slug,title,body,tags,visibility,source_url) values
('intelligence-features-status','Nari memory, knowledge and context features',
 'Nari supports explicitly saved language, favorite genre and spoiler preferences through Settings > Nari memory. Members can correct or delete their own preferences; they expire after 90 days. Private preferences never enter public threads. Knowledge is administrator-curated with version and source history. Conversation context is bounded and older relevant quotations may be summarized extractively; arbitrary permanent free-text recall is not supported. Do not claim facts about unavailable history.',
 array['memory','features','preferences','context','knowledge'],'public','https://github.com/halluyapp/hallyuapp/blob/ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799/docs/NARI_INTELLIGENCE.md'),
('community-safety-standards','Community rules and safety',
 'Treat fans respectfully across K-drama, C-drama, anime and Hollywood. Do not harass, dox, threaten, spam or post explicit sexual content. Avoid spoilers when a member has asked to avoid them. Report concerning content through reporting surfaces. A report is not proof of a violation; moderation outcomes require actual authorized backend evidence. Never disclose reporters or private conversations.',
 array['community','rules','safety','spoilers','report'],'public','https://github.com/halluyapp/hallyuapp/blob/ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799/supabase/functions/_shared/operator/prompt.ts'),
('staff-roles-boundaries','Staff roles and permissions',
 'Application roles are member, moderator, admin and ceo. Moderators, admins and CEO have moderation-console access; global administration and Nari knowledge editing require admin or CEO. Client helpers control presentation only: database authorization, active account checks, task-bound tool permissions and approval policy are authoritative. Knowledge cannot grant privileges.',
 array['roles','permissions','staff','administration'],'staff','https://github.com/halluyapp/hallyuapp/blob/ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799/lib/roles.ts'),
('campaign-events-evidence','Campaigns, events and announcements evidence rules',
 'Campaign/event tooling and scheduling records exist, but their presence does not establish that any particular campaign, event or announcement is active, approved or published. Query authorized current records before describing dates, participants or completion. No verified current event or announcement is supplied by this static entry. Drafts must not be described as published. Publication must satisfy the current configured approval policy.',
 array['campaigns','events','announcements','calendar','publish'],'staff','https://github.com/halluyapp/hallyuapp/blob/ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799/supabase/functions/_shared/operator/tools.ts'),
('release-and-operations-evidence','Release information, known limitations and procedures',
 'Source implementation is not proof of successful production deployment or model availability. Consult release evidence, actual task outcomes and provider health before reporting operational status. Record failures honestly without silently switching provider or credit pool. Gemini voice notes and playback are separate from text reasoning; live full-duplex voice is not implemented by the voice-note endpoint. Never claim all device or model combinations are tested. Known defects require dated evidence, not inference from old conversations.',
 array['release','bugs','operations','procedures','voice','status'],'staff','https://github.com/halluyapp/hallyuapp/blob/ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799/docs/NARI_INTELLIGENCE.md')
on conflict(slug) do nothing returning *
)
insert into public.operator_knowledge_revision(knowledge_id,version,title,body,source_url,visibility,tags,is_active,edited_by)
select id,version,title,body,source_url,visibility,tags,is_active,updated_by from added;
