import { LEGAL_VERSION } from "@umaru/protocol";

/**
 * Nội dung Điều khoản sử dụng & Chính sách quyền riêng tư (EN/VI).
 *
 * Đây là **nguồn duy nhất** của văn bản — trang `/terms` và `/privacy` render
 * thẳng từ đây. Sửa nội dung thì tăng `LEGAL_VERSION` trong
 * `packages/protocol/src/legal.ts` (số này được ghi vào `users.terms_version`
 * lúc đăng ký, nên biết được tài khoản đã đồng ý bản nào).
 *
 * Văn bản mô tả đúng những gì hệ thống thực sự làm ở thời điểm này; đừng thêm
 * cam kết mà mã nguồn chưa đáp ứng được (xem docs/legal/README.md).
 */

export type LegalLocale = "en" | "vi";
export type LegalDocId = "terms" | "privacy";

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDoc {
  title: string;
  /** Ngày hiệu lực, cùng giá trị với LEGAL_VERSION. */
  updated: string;
  intro: string[];
  sections: LegalSection[];
}

export const LEGAL_UPDATED = LEGAL_VERSION;

/** Thông tin liên hệ hiển thị trong cả hai văn bản. */
export const LEGAL_CONTACT_EMAIL = "lexuanminhtufw@gmail.com";
export const LEGAL_OPERATOR = "Yami, lxmtuu";

const termsVi: LegalDoc = {
  title: "Điều khoản sử dụng",
  updated: LEGAL_UPDATED,
  intro: [
    `Umaru là dịch vụ trò chuyện cộng đồng do ${LEGAL_OPERATOR} vận hành ("Umaru", "chúng tôi"). Bằng việc tạo tài khoản hoặc tiếp tục sử dụng dịch vụ, bạn đồng ý với các điều khoản dưới đây. Nếu không đồng ý, vui lòng không sử dụng dịch vụ.`,
    "Văn bản này là bản nháp kỹ thuật của giai đoạn tiền phát hành và sẽ được rà soát pháp lý trước khi công bố chính thức.",
  ],
  sections: [
    {
      heading: "1. Điều kiện sử dụng",
      paragraphs: [
        "Bạn phải từ đủ 13 tuổi trở lên để tạo tài khoản. Nếu bạn dưới 18 tuổi, bạn cần có sự đồng ý của cha mẹ hoặc người giám hộ hợp pháp. Tại các quốc gia thuộc EU/EEA, độ tuổi tối thiểu có thể cao hơn (13–16 tuỳ từng nước) theo GDPR; khi đó độ tuổi theo luật địa phương được áp dụng.",
        "Bạn chịu trách nhiệm bảo mật mật khẩu và mọi hoạt động diễn ra dưới tài khoản của mình. Hãy thông báo cho chúng tôi ngay khi phát hiện truy cập trái phép.",
      ],
    },
    {
      heading: "2. Tài khoản của bạn",
      paragraphs: [
        "Bạn cung cấp tên đăng nhập, tên hiển thị và địa chỉ email chính xác, và cập nhật khi có thay đổi. Chúng tôi gửi email xác thực khi bạn đăng ký; tài khoản chưa xác thực vẫn dùng được nhưng sẽ được nhắc xác thực trong ứng dụng.",
        "Bạn có thể yêu cầu xoá tài khoản bất cứ lúc nào bằng cách gửi email tới địa chỉ liên hệ ở mục 10. Việc xoá tài khoản cũng xoá nội dung gắn với tài khoản đó (tin nhắn, tệp đính kèm, tư cách thành viên), trừ dữ liệu chúng tôi buộc phải giữ theo quy định pháp luật.",
      ],
    },
    {
      heading: "3. Nội dung do bạn tạo",
      paragraphs: [
        "Bạn giữ bản quyền đối với tin nhắn, tệp và nội dung khác mà bạn đăng tải. Bạn cấp cho chúng tôi quyền không độc quyền, miễn phí, chỉ trong phạm vi cần thiết để lưu trữ, truyền tải và hiển thị nội dung đó cho những người bạn chia sẻ.",
        "Bạn chịu trách nhiệm về nội dung mình đăng và cam kết có quyền hợp pháp để đăng nội dung đó.",
      ],
    },
    {
      heading: "4. Hành vi không được phép",
      paragraphs: ["Khi sử dụng Umaru, bạn không được:"],
      bullets: [
        "đăng nội dung vi phạm pháp luật, xâm hại trẻ em, kích động bạo lực hoặc thù địch, hoặc xâm phạm quyền của người khác;",
        "quấy rối, đe doạ, phát tán thông tin riêng tư của người khác khi chưa được phép;",
        "gửi thư rác, tự động hoá quy mô lớn, dò quét hoặc tấn công hệ thống, vượt qua giới hạn kỹ thuật;",
        "mạo danh người khác hoặc tổ chức khác;",
        "tải lên phần mềm độc hại hoặc tệp nhằm khai thác lỗ hổng.",
      ],
    },
    {
      heading: "5. Kiểm duyệt và chấm dứt",
      paragraphs: [
        "Chúng tôi có thể xoá nội dung hoặc tạm ngưng/khoá tài khoản nếu phát hiện hành vi vi phạm điều khoản này hoặc khi có yêu cầu hợp pháp từ cơ quan có thẩm quyền. Khi cần thiết và trong khả năng của mình, chúng tôi sẽ thông báo lý do.",
        "Bạn có thể báo cáo nội dung hoặc hành vi vi phạm tới địa chỉ liên hệ ở mục 10; chúng tôi xem xét và phản hồi trong thời gian hợp lý (thường trong vòng 7 ngày làm việc).",
        "Bạn có thể ngừng sử dụng dịch vụ bất cứ lúc nào.",
      ],
    },
    {
      heading: "6. Dịch vụ cung cấp thế nào",
      paragraphs: [
        "Dịch vụ đang trong giai đoạn phát triển. Chúng tôi cố gắng duy trì hoạt động ổn định nhưng không bảo đảm dịch vụ luôn sẵn sàng, không lỗi hoặc không mất dữ liệu. Tính năng có thể thay đổi hoặc tạm dừng để bảo trì.",
        "Bạn nên tự sao lưu nội dung quan trọng. Chúng tôi không chịu trách nhiệm với thiệt hại gián tiếp, mất lợi nhuận hoặc mất dữ liệu phát sinh từ việc sử dụng dịch vụ, trong phạm vi pháp luật cho phép.",
      ],
    },
    {
      heading: "7. Nội dung của người khác",
      paragraphs: [
        "Umaru cho phép người dùng tạo server, kênh và nội dung riêng. Những nội dung đó do người dùng hoặc quản trị server chịu trách nhiệm, không phải quan điểm của Umaru. Nếu bạn thấy nội dung vi phạm, hãy báo cáo.",
      ],
    },
    {
      heading: "8. Thay đổi điều khoản",
      paragraphs: [
        "Khi điều khoản thay đổi quan trọng, chúng tôi sẽ thông báo trong ứng dụng hoặc qua email trước khi thay đổi có hiệu lực. Tiếp tục sử dụng dịch vụ sau ngày hiệu lực nghĩa là bạn chấp nhận bản mới. Phiên bản bạn đã đồng ý được ghi lại khi đăng ký.",
      ],
    },
    {
      heading: "9. Luật áp dụng",
      paragraphs: [
        "Điều khoản này được điều chỉnh bởi pháp luật Việt Nam, không ảnh hưởng tới các quyền bắt buộc mà pháp luật nơi bạn cư trú dành cho bạn với tư cách người tiêu dùng. Tranh chấp được ưu tiên giải quyết thương lượng; nếu không thành, toà án có thẩm quyền tại Việt Nam giải quyết.",
      ],
    },
    {
      heading: "10. Liên hệ",
      paragraphs: [`Mọi câu hỏi về điều khoản này: ${LEGAL_CONTACT_EMAIL} (${LEGAL_OPERATOR}).`],
    },
  ],
};

const termsEn: LegalDoc = {
  title: "Terms of Service",
  updated: LEGAL_UPDATED,
  intro: [
    `Umaru is a community chat service operated by ${LEGAL_OPERATOR} ("Umaru", "we", "us"). By creating an account or continuing to use the service, you agree to these terms. If you do not agree, please do not use the service.`,
    "This is a technical draft for the pre-launch phase and will undergo legal review before the official release.",
  ],
  sections: [
    {
      heading: "1. Eligibility",
      paragraphs: [
        "You must be at least 13 years old to create an account. If you are under 18, you need permission from a parent or legal guardian. In EU/EEA countries the minimum age may be higher (13–16 depending on the country) under the GDPR; in that case the local legal age applies.",
        "You are responsible for keeping your password secure and for all activity under your account. Tell us immediately if you notice unauthorised access.",
      ],
    },
    {
      heading: "2. Your account",
      paragraphs: [
        "You provide an accurate username, display name and email address, and keep them up to date. We send a verification email when you sign up; unverified accounts still work but the app will keep reminding you to verify.",
        "You may request account deletion at any time by emailing the contact address in section 10. Deleting your account also deletes content tied to it (messages, attachments, memberships), except data we are required to keep by law.",
      ],
    },
    {
      heading: "3. Your content",
      paragraphs: [
        "You keep the copyright to the messages, files and other content you upload. You grant us a non-exclusive, royalty-free licence limited to storing, transmitting and displaying that content to the people you share it with.",
        "You are responsible for what you post and confirm you have the legal right to post it.",
      ],
    },
    {
      heading: "4. Prohibited conduct",
      paragraphs: ["When using Umaru you must not:"],
      bullets: [
        "post content that is illegal, sexualises minors, incites violence or hatred, or infringes the rights of others;",
        "harass, threaten or share other people's private information without permission;",
        "send spam, run large-scale automation, scan or attack the service, or bypass technical limits;",
        "impersonate another person or organisation;",
        "upload malware or files intended to exploit vulnerabilities.",
      ],
    },
    {
      heading: "5. Moderation and termination",
      paragraphs: [
        "We may remove content or suspend/close accounts if we find a breach of these terms or when required by a lawful authority. Where reasonable and possible, we will tell you why.",
        "You can report abusive content or behaviour to the contact address in section 10; we review reports and respond within a reasonable time (typically within 7 business days).",
        "You may stop using the service at any time.",
      ],
    },
    {
      heading: "6. How the service is provided",
      paragraphs: [
        "The service is under active development. We work to keep it running smoothly but do not guarantee that it is always available, error-free or that no data will be lost. Features may change or be paused for maintenance.",
        "Please keep your own backups of important content. To the extent permitted by law, we are not liable for indirect damages, lost profits or data loss arising from use of the service.",
      ],
    },
    {
      heading: "7. Content from others",
      paragraphs: [
        "Umaru lets users create their own servers, channels and content. That content is the responsibility of those users and server administrators, not an expression of Umaru's views. If you see content that breaks these terms, report it.",
      ],
    },
    {
      heading: "8. Changes to these terms",
      paragraphs: [
        "When these terms change materially, we will notify you in the app or by email before the change takes effect. Continuing to use the service after the effective date means you accept the new version. The version you accepted is recorded when you sign up.",
      ],
    },
    {
      heading: "9. Governing law",
      paragraphs: [
        "These terms are governed by the laws of Vietnam, without limiting any mandatory consumer rights you have where you live. Disputes should first be settled amicably; otherwise the competent courts in Vietnam have jurisdiction.",
      ],
    },
    {
      heading: "10. Contact",
      paragraphs: [`Questions about these terms: ${LEGAL_CONTACT_EMAIL} (${LEGAL_OPERATOR}).`],
    },
  ],
};

const privacyVi: LegalDoc = {
  title: "Chính sách quyền riêng tư",
  updated: LEGAL_UPDATED,
  intro: [
    `Chính sách này giải thích dữ liệu cá nhân nào Umaru thu thập, vì sao, lưu bao lâu và bạn có những quyền gì. Bên kiểm soát dữ liệu: ${LEGAL_OPERATOR}. Liên hệ: ${LEGAL_CONTACT_EMAIL}.`,
    "Văn bản này là bản nháp kỹ thuật của giai đoạn tiền phát hành và sẽ được rà soát pháp lý trước khi công bố chính thức.",
  ],
  sections: [
    {
      heading: "1. Dữ liệu chúng tôi thu thập",
      paragraphs: ["Chúng tôi thu thập đúng những gì cần để dịch vụ hoạt động:"],
      bullets: [
        "**Thông tin tài khoản:** tên đăng nhập, tên hiển thị, email, mật khẩu đã băm bằng Argon2id (chúng tôi không bao giờ lưu hay đọc được mật khẩu gốc);",
        "**Nội dung bạn tạo:** tin nhắn, tệp đính kèm, server/kênh/role do bạn tạo, trạng thái đã đọc và các lượt nhắc bạn;",
        "**Dữ liệu phiên:** token làm mới đã băm, thời hạn phiên, thông tin trình duyệt (user agent) để bạn nhận ra thiết bị đã đăng nhập;",
        "**Dữ liệu kỹ thuật:** thời điểm, địa chỉ IP, phương thức và mã phản hồi của mỗi yêu cầu, phục vụ vận hành và chống lạm dụng.",
      ],
    },
    {
      heading: "2. Chúng tôi dùng dữ liệu để làm gì",
      paragraphs: [
        "Cơ sở pháp lý theo GDPR: **thực hiện hợp đồng** (cung cấp dịch vụ bạn đăng ký), **lợi ích hợp pháp** (an toàn hệ thống, chống lạm dụng), và **sự đồng ý** khi bạn chủ động bật một tính năng tuỳ chọn.",
      ],
      bullets: [
        "hiển thị tin nhắn, kênh, server đúng người được xem theo phân quyền;",
        "gửi email xác thực tài khoản và thông báo quan trọng về dịch vụ;",
        "tính năng chưa đọc, lượt nhắc và tìm kiếm trong phạm vi bạn được xem;",
        "phát hiện, ngăn chặn lạm dụng và khắc phục sự cố.",
      ],
    },
    {
      heading: "3. Điều chúng tôi không làm",
      paragraphs: [
        "Chúng tôi **không bán** dữ liệu cá nhân, **không dùng** nội dung tin nhắn để quảng cáo, **không** cài trình theo dõi quảng cáo hay công cụ phân tích bên thứ ba vào ứng dụng.",
        "Chúng tôi không đọc tin nhắn riêng của bạn ngoại trừ trường hợp cần thiết để xử lý sự cố, xử lý báo cáo vi phạm, hoặc theo yêu cầu hợp pháp của cơ quan có thẩm quyền.",
      ],
    },
    {
      heading: "4. Chia sẻ với bên thứ ba",
      paragraphs: [
        "Chúng tôi chỉ chia sẻ dữ liệu với nhà cung cấp hạ tầng cần thiết để chạy dịch vụ (máy chủ, cơ sở dữ liệu, dịch vụ gửi email), và với cơ quan nhà nước có thẩm quyền khi pháp luật yêu cầu. Nhà cung cấp chỉ được xử lý dữ liệu theo hướng dẫn của chúng tôi.",
        "Dữ liệu có thể được xử lý ngoài Việt Nam (ví dụ máy chủ tại Singapore hoặc EU/US). Khi chuyển dữ liệu ra khỏi EU/EEA, chúng tôi áp dụng biện pháp bảo vệ theo GDPR.",
      ],
    },
    {
      heading: "5. Thời gian lưu",
      paragraphs: ["Chúng tôi lưu dữ liệu không lâu hơn mức cần thiết:"],
      bullets: [
        "**Tài khoản:** cho tới khi bạn yêu cầu xoá;",
        "**Tin nhắn & tệp:** cho tới khi bạn (hoặc người có quyền) xoá; xoá tin là xoá luôn tệp đính kèm;",
        "**Link xác thực email:** 24 giờ, dùng một lần;",
        "**Token làm mới (phiên đăng nhập):** tối đa 30 ngày kể từ khi cấp, hoặc bị thu hồi khi bạn đăng xuất;",
        "**Log kỹ thuật:** tối đa 30 ngày.",
      ],
    },
    {
      heading: "6. Bảo mật",
      paragraphs: [
        "Mật khẩu được băm bằng Argon2id; token làm mới và token xác thực email chỉ được lưu dưới dạng băm SHA-256; kết nối tới dịch vụ dùng TLS khi triển khai công khai. Không hệ thống nào an toàn tuyệt đối — nếu xảy ra sự cố ảnh hưởng tới dữ liệu cá nhân, chúng tôi sẽ thông báo cho người bị ảnh hưởng và cơ quan có thẩm quyền theo quy định.",
      ],
    },
    {
      heading: "7. Quyền của bạn",
      paragraphs: [
        "Theo GDPR và Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân (Việt Nam), bạn có quyền:",
      ],
      bullets: [
        "**truy cập** dữ liệu chúng tôi giữ về bạn và nhận bản sao;",
        "**chỉnh sửa** thông tin không chính xác;",
        "**xoá** tài khoản và dữ liệu liên quan;",
        "**hạn chế hoặc phản đối** một số cách xử lý;",
        "**rút lại sự đồng ý** (không ảnh hưởng tính hợp pháp của việc xử lý trước đó);",
        "**khiếu nại** tới cơ quan bảo vệ dữ liệu nơi bạn cư trú.",
      ],
    },
    {
      heading: "8. Trẻ em",
      paragraphs: [
        "Dịch vụ dành cho người từ 13 tuổi trở lên. Chúng tôi không cố ý thu thập dữ liệu của trẻ dưới 13 tuổi; nếu phát hiện, chúng tôi sẽ xoá tài khoản đó. Phụ huynh có thể liên hệ để yêu cầu xoá dữ liệu của con mình.",
      ],
    },
    {
      heading: "9. Cách thực hiện quyền",
      paragraphs: [
        `Gửi email tới ${LEGAL_CONTACT_EMAIL} từ địa chỉ đã đăng ký, nêu rõ yêu cầu. Chúng tôi phản hồi trong vòng 30 ngày (có thể gia hạn một lần nếu yêu cầu phức tạp, và sẽ thông báo cho bạn). Thực hiện quyền là miễn phí, trừ trường hợp yêu cầu lặp lại quá mức.`,
      ],
    },
    {
      heading: "10. Thay đổi chính sách",
      paragraphs: [
        `Khi chính sách thay đổi quan trọng, chúng tôi thông báo trong ứng dụng hoặc qua email. Ngày hiệu lực hiện tại: ${LEGAL_UPDATED}.`,
      ],
    },
    {
      heading: "11. Liên hệ",
      paragraphs: [`${LEGAL_OPERATOR} — ${LEGAL_CONTACT_EMAIL}.`],
    },
  ],
};

const privacyEn: LegalDoc = {
  title: "Privacy Policy",
  updated: LEGAL_UPDATED,
  intro: [
    `This policy explains what personal data Umaru collects, why, how long we keep it and what rights you have. Data controller: ${LEGAL_OPERATOR}. Contact: ${LEGAL_CONTACT_EMAIL}.`,
    "This is a technical draft for the pre-launch phase and will undergo legal review before the official release.",
  ],
  sections: [
    {
      heading: "1. What we collect",
      paragraphs: ["We collect only what the service needs to work:"],
      bullets: [
        "**Account data:** username, display name, email, and a password hashed with Argon2id (we never store or see the plain password);",
        "**Content you create:** messages, attachments, servers/channels/roles you create, read states and mentions of you;",
        "**Session data:** hashed refresh tokens, session expiry, browser user agent (so you can recognise signed-in devices);",
        "**Technical data:** timestamp, IP address, method and response status of each request, for operations and abuse prevention.",
      ],
    },
    {
      heading: "2. Why we use it",
      paragraphs: [
        "Legal bases under the GDPR: **performance of a contract** (providing the service you signed up for), **legitimate interests** (system safety, abuse prevention), and **consent** where you opt into an optional feature.",
      ],
      bullets: [
        "displaying messages, channels and servers only to people allowed by permissions;",
        "sending account verification emails and important service notices;",
        "unread counts, mentions and search within what you are allowed to see;",
        "detecting and stopping abuse, and fixing incidents.",
      ],
    },
    {
      heading: "3. What we do not do",
      paragraphs: [
        "We **do not sell** personal data, **do not use** message content for advertising, and **do not** embed third-party ad trackers or analytics in the app.",
        "We do not read your private messages, except where necessary to investigate an incident, handle an abuse report, or comply with a lawful request from a competent authority.",
      ],
    },
    {
      heading: "4. Sharing",
      paragraphs: [
        "We share data only with infrastructure providers needed to run the service (servers, database, email delivery) and with competent public authorities where the law requires it. Providers may process data only on our instructions.",
        "Data may be processed outside Vietnam (for example servers in Singapore, the EU or the US). When transferring data out of the EU/EEA we apply GDPR safeguards.",
      ],
    },
    {
      heading: "5. Retention",
      paragraphs: ["We keep data no longer than necessary:"],
      bullets: [
        "**Account:** until you ask us to delete it;",
        "**Messages & files:** until you (or someone with permission) delete them; deleting a message deletes its attachments;",
        "**Email verification links:** 24 hours, single use;",
        "**Refresh tokens (sessions):** at most 30 days from issue, or revoked when you log out;",
        "**Technical logs:** at most 30 days.",
      ],
    },
    {
      heading: "6. Security",
      paragraphs: [
        "Passwords are hashed with Argon2id; refresh and email verification tokens are stored only as SHA-256 hashes; traffic uses TLS in the public deployment. No system is perfectly secure — if a breach affects personal data, we will notify affected users and authorities as required.",
      ],
    },
    {
      heading: "7. Your rights",
      paragraphs: [
        "Under the GDPR and Vietnam's Decree 13/2023/ND-CP on personal data protection, you have the right to:",
      ],
      bullets: [
        "**access** the data we hold about you and obtain a copy;",
        "**rectify** inaccurate information;",
        "**erase** your account and related data;",
        "**restrict or object to** certain processing;",
        "**withdraw consent** (without affecting the lawfulness of prior processing);",
        "**lodge a complaint** with the data protection authority where you live.",
      ],
    },
    {
      heading: "8. Children",
      paragraphs: [
        "The service is for people aged 13 and over. We do not knowingly collect data from children under 13; if we learn of such an account we will delete it. Parents may contact us to request deletion of their child's data.",
      ],
    },
    {
      heading: "9. Exercising your rights",
      paragraphs: [
        `Email ${LEGAL_CONTACT_EMAIL} from your registered address, stating your request. We respond within 30 days (extendable once for complex requests, and we will tell you). Exercising your rights is free of charge, except for manifestly excessive or repetitive requests.`,
      ],
    },
    {
      heading: "10. Changes",
      paragraphs: [
        `When this policy changes materially we notify you in the app or by email. Current effective date: ${LEGAL_UPDATED}.`,
      ],
    },
    {
      heading: "11. Contact",
      paragraphs: [`${LEGAL_OPERATOR} — ${LEGAL_CONTACT_EMAIL}.`],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalDocId, Record<LegalLocale, LegalDoc>> = {
  terms: { vi: termsVi, en: termsEn },
  privacy: { vi: privacyVi, en: privacyEn },
};
