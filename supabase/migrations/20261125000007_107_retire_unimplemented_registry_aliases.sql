-- Live audit found legacy registry aliases without any deployed worker implementation.
-- Preserve the rows/history, but explicitly disable them rather than advertising capabilities
-- that silently disappear from model schemas. Supported replacements are in the inventory.
update public.operator_tool set enabled=false where name in (
 'post.draft','post.search','post.inspect','comment.list','world.balance','moderation.hide',
 'moderation.recommend','research.read_page','research.images','memory.save','memory.search',
 'memory.update','memory.delete','campaign.list','campaign.update','campaign.publish','campaign.close',
 'schedule.list','schedule.create','schedule.update','ops.cancel_task'
);
