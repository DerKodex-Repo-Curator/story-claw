/** Shot constraints shared by storyboard planning and H3 prompt conversion. */
export const STORY_PANEL_VISUAL_RULES = `== 分镜静态与动态共用约束 ==
- 一格一事：每个 panel 只表达原文中的一个有效信息点，动作与叙事时间顺序不能改写；不添加无关人物、道具、动作或表演节拍。
- 静态描述限定本镜实际可见的主体/部位、景别、角度、构图、姿态、位置和必要光线/情绪；人物不入画就不写其姓名、位置或行为，不为说明对话关系把另一人带入单人镜头。
- 手或身体局部镜头只描述可见部位及动作，不引出完整人物、脸或外貌；角色标签只用于上游锁定参考图身份，不把标签身份当作全身入画要求。
- 角色必须使用精确参考图标签；没有原文支持的长期换装或外形变化时沿用同一阶段。参考图已经提供的外貌、服装和风格不重复描述。
- 所有景别保留当前场景参考；近景/特写只使用必要的局部背景，不能为交代全局擅自改成全景或引入画外人物。
- 动态描述基于静态构图，只补本镜原文支持的必要动作/变化和已选镜头运动；静态与动态不能矛盾，不能以重复细节把提示词越写越长。
- 承接前镜头及上一组 end_positions，人物站位、相对位置、动作方向和必要道具状态不得无依据跳变；机位遵守同一关系轴侧别，不能只改视线来掩盖越轴。
- 不因参考图里元素较多就让全部元素入画；禁止新增、移动、复制家具。`;

export const STORY_CAMERA_MOTION_RULES = `镜头运动采用固定或推近；只有组内可朗读字数除以 panel 数至少为 14 时，才允许已规划的缓慢、小幅度拉远。不要新增摇、移、环绕、快速推拉或镜内切镜头。`;

/** Keep the original small pull-back allowance, excluding unread annotations. */
export function storyCameraMotionPolicy(groupText: string, panelCount: number) {
  if (!Number.isInteger(panelCount) || panelCount < 1) throw new Error("Story panel count must be a positive integer");
  const spokenText = groupText.replace(/【[^】]*】/g, "");
  return {fixed: true, pushIn: true, slightPullAllowed: spokenText.length / panelCount >= 14};
}
