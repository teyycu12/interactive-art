import { PixelScene } from './PixelScene.js';
import { paintGymRoom, paintGymProp } from './gymArt.js';

export class GymScene extends PixelScene {
  static THEME_ID = 'gym';
  static TITLE = '活力體育館';
  static SUBTITLE = 'THE SPORTS HALL　 /　一起動起來';
  static paintRoom = paintGymRoom;
  static paintProp = paintGymProp;
  static FALLBACK = ['plant', '綠色盆栽', '運動完看看綠色，讓眼睛休息一下'];
  static ITEMS = {
    k_cart: ['ballcart', '籃球推車', '挑一顆手感最好的球'],
    k_island: ['hoop', '籃球架', '唰！空心進籃'],
    k_dining: ['podium', '頒獎台', '站上去，比個勝利手勢'],
    k_stool_l: ['cone', '左側角錐', '繞過角錐，練練腳步'],
    k_stool_r: ['cone', '右側角錐', '繞過角錐，練練腳步'],
    k_pantry: ['trophy', '獎盃櫃', '學長姐留下的榮耀'],
    k_dishes: ['ballrack', '球具架', '排球、足球、籃球，選一樣吧'],
    k_market: ['basket', '器材籃', '用完的器材放回這裡'],
    spk_l: ['scoretable', '計分台', '比數更新，誰要追分？'],
    spk_r: ['water', '補水站', '咕嚕咕嚕，記得補充水分'],
    tbl_1: ['treadmill', '跑步機', '先慢跑五分鐘暖身'],
    tbl_2: ['bike', '飛輪車', '踩起來，心跳加速'],
    tbl_3: ['dumbbells', '啞鈴架', '舉起來，再一組！'],
    sofa_1: ['bleacher', '觀眾看台', '幫場上的朋友加油'],
    sofa_2: ['bench', '休息長椅', '坐下來喘口氣'],
    ctbl_1: ['cooler', '運動飲料桶', '來一瓶，補充電解質'],
    grd_1: ['hurdle', '跨欄', '抬腿，一口氣跨過去'],
    grd_2: ['vault', '跳箱', '助跑、踏板、撐跳！'],
    grd_3: ['tire', '訓練輪胎', '翻一圈，力量全開'],
  };
}
