import fs from 'fs';
import handlebars from 'handlebars';
import ApiError from '../errors/apiError';
import httpStatus from 'http-status';
import { Transporter, getTransporterForClinic } from './Transporter';
import config from '../config';

type IEmailProps = {
    pathName: string;
    replacementObj: any,
    toMail: string,
    subject: string,
    // Pass 31 — Multi-Tenant Clinics (per-clinic email). Optional — undefined for any
    // caller that hasn't been updated to look up its clinic's credentials, or for
    // notifications with no clinic context at all. See getTransporterForClinic's own
    // comment for the fallback behavior.
    clinic?: { gmailAppEmail: string | null; gmailAppPassEnc: string | null } | null,
}
export const EmailtTransporter = async({pathName,replacementObj, toMail, subject, clinic }:IEmailProps) =>{
    const html = await readHtmlFile(pathName);
    const template = handlebars.compile(html);
    const htmlToSend = template(replacementObj);

    const transporter = getTransporterForClinic(clinic);
    // "From" matches whichever account is actually authenticated to send — using the
    // clinic's own address when it has one configured, falling back to the platform
    // admin address otherwise. Sending "from" an address the authenticated account
    // doesn't own is what gets flagged as spoofing by mail providers, so this must
    // track the transporter choice above, not be independent of it.
    const fromAddress = clinic?.gmailAppEmail || config.adminEmail;

    const mailOptions = {
        from: `<${fromAddress}>`,
        to: toMail,
        subject: subject,
        html: htmlToSend
    };

    try {
        await transporter.sendMail(mailOptions);
    } catch (error) {
        console.log(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Unable to send Email !");
    }
};

const readHtmlFile = async(path:string): Promise<string> =>{
    try {
        const html = await fs.promises.readFile(path, {encoding: 'utf-8'});
        return html
    } catch (error) {
        console.log("Error Reading html file", error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Unable to read HTML file")
    }
}