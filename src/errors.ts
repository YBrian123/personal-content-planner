export const errorText=(e:unknown):string=>{
  const message=e instanceof Error?e.message:String((e as {message?:string})?.message||e);
  const known:Record<string,string>={TITLE_REQUIRED:'请填写1～300字的标题',NAME_REQUIRED:'请填写1～200字的名称',INVALID_DATE:'日期格式不正确',INVALID_TIMESTAMP:'请核对具体时分和时区',INVALID_RELATED_ITEM:'关联事项编号不存在，请核对',INVALID_NUMBER:'排序与投入请填写有效整数',INVALID_EFFORT:'单次投入须为正整数分钟',UNDO_CONFLICT:'记录已发生其他变化，请打开历史核对后修正',TEXT_TOO_LONG:'单个文本字段超过80,000字，请缩短内容',INVALID_PARENT:'目标计划不存在或不可用',INVALID_FIELD:'字段不受支持，请刷新页面核对',FORBIDDEN:'当前账号尚未获得本人访问权限',CONFLICT:'记录已在另一处修改，请刷新核对。你的输入仍保留。',STALE_GENERATION:'数据已经恢复或升级，请刷新核对旧输入。',RANGE_CHANGED:'范围已经变化，请重新预览后操作。',INVALID_TIME_ORDER:'完成时间不能早于开始时间',INVALID_DATE_ORDER:'计划结束不能早于计划开始',SNAPSHOT_BUDGET:'操作前快照无法保存，请先导出备份并处理容量。',BACKUP_CAPACITY:'这份数据超出单次备份容量，请先处理容量。',BATCH_INCOMPLETE:'批次还有未完成事项，可选择记录为本轮停止。',SCHEMA_MISMATCH:'数据结构已升级，请更新页面。'};
  for(const [code,text] of Object.entries(known).sort(([a],[b])=>b.length-a.length))if(message.includes(code))return text;
  if(message.includes('INVALID_LINKS'))return '引用列表格式不正确，请检查备份或引用内容。';
  if(message.includes('INVALID_BASELINE'))return '原定范围记录格式不正确，请核对备份。';
  if(/fetch|network|timeout/i.test(message))return '数据服务暂时不可用，请检查网络或项目状态。输入仍保留。';
  return message.slice(0,300);
};
